'use strict';
const zlib = require('zlib');
const fs = require('fs');

const traceFile = 'C:\\Users\\2461898\\Downloads\\qaai_fixed\\qaai_fixed\\qaai_fixed\\playwright\\telemetry\\d84e3a57-f3c4-4c7a-9dd1-fd294edd12ce\\pending-cc13d9c4-862c-4243-ad7a-e348c37b9beb.json.gz';

const compressed = fs.readFileSync(traceFile);
const raw = zlib.gunzipSync(compressed).toString('utf8');
const trace = JSON.parse(raw);

console.log('=== CONDUCTOR/CRITIC RUN TRACE ===');
console.log('Test Case:', trace.testCaseName);
console.log('Total turns:', trace.turns.length);
console.log('Total elapsed:', trace.totalElapsedMs, 'ms');
console.log('stabilityCapHits:', trace.stabilityCapHits);
console.log('assertionPolls:', trace.assertionPolls ? trace.assertionPolls.length : 0);
console.log('');

let criticCount = 0;
let locatorFailures = [];
let passiveSteps = [];
let allTools = [];

trace.turns.forEach((t, idx) => {
  const tools = (t.toolUses || []).map(u => u.name);
  const results = (t.toolResults || []);

  // Check for critic invocation in assistant text or tool names
  const isCritic = tools.some(n => n.includes('critic') || n.includes('Critic')) ||
    (t.assistantText || '').toLowerCase().includes('critic') ||
    tools.some(n => n === 'inline_critic');

  // Check for locator failures
  const failures = results.filter(r => r.isError || !r.ok).map(r => ({
    tool: r.name,
    err: (r.errorPreview || '').slice(0, 100)
  }));

  // Check for passive (page_ready/url_reached)
  const hasPassive = tools.some(n => n.includes('page_ready') || n.includes('url_reached') || n.includes('assert_url') || n.includes('wait'));

  // Token usage
  const usage = t.usage || {};
  const cacheHit = usage.cacheReadTokens > 0;

  const line = `Turn ${String(idx).padStart(2)}: stop=${t.stopReason} tools=[${tools.join(',')}]${isCritic ? ' **CRITIC**' : ''} elapsed=${t.elapsedMs}ms in=${usage.inputTokens} out=${usage.outputTokens} cacheR=${usage.cacheReadTokens}${failures.length ? ' FAIL' : ''}`;
  console.log(line);

  if (t.assistantText) {
    console.log(`  > ${t.assistantText.slice(0, 120)}`);
  }

  if (failures.length) {
    failures.forEach(f => console.log(`  !! ERROR: ${f.tool}: ${f.err}`));
    locatorFailures.push({ turn: idx, failures });
  }

  if (isCritic) criticCount++;
  if (hasPassive) passiveSteps.push(idx);
  allTools.push(...tools);
});

console.log('\n=== SUMMARY ===');
console.log('Critic invocations:', criticCount);
console.log('Locator failures at turns:', locatorFailures.map(f => f.turn).join(', ') || 'none');
console.log('Passive step turns:', passiveSteps.join(', ') || 'none');
console.log('Tool frequency:');
const freq = {};
allTools.forEach(t => freq[t] = (freq[t] || 0) + 1);
Object.entries(freq).sort((a,b) => b[1]-a[1]).forEach(([t, c]) => console.log(' ', c, t));
