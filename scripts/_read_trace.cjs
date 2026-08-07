'use strict';
const zlib = require('zlib');
const fs = require('fs');

const traceFile = 'C:\\Users\\2461898\\Downloads\\qaai_fixed\\qaai_fixed\\qaai_fixed\\playwright\\telemetry\\d84e3a57-f3c4-4c7a-9dd1-fd294edd12ce\\pending-cc13d9c4-862c-4243-ad7a-e348c37b9beb.json.gz';

if (!fs.existsSync(traceFile)) {
  console.log('Trace file not found:', traceFile);
  process.exit(0);
}

const compressed = fs.readFileSync(traceFile);
const raw = zlib.gunzipSync(compressed).toString('utf8');
const trace = JSON.parse(raw);

console.log('=== RICH TRACE ===');
console.log('Keys:', Object.keys(trace).join(', '));
if (trace.turns) {
  console.log('Total turns:', trace.turns.length);
  trace.turns.forEach((t, i) => {
    const tools = (t.toolCalls || []).map(tc => tc.name || tc.tool).join(', ');
    const criticFlag = t.criticInvoked ? ' [CRITIC]' : '';
    const tokenUsage = t.tokenUsage ? ` tokens_in=${t.tokenUsage.input_tokens} out=${t.tokenUsage.output_tokens}` : '';
    const elapsedMs = t.elapsedMs ? ` ${t.elapsedMs}ms` : '';
    console.log(`Turn ${t.turn || i}: tools=[${tools}]${criticFlag}${elapsedMs}${tokenUsage}`);
    // Show any errors
    (t.toolCalls || []).forEach(tc => {
      if (tc.error || (tc.result && tc.result.isError)) {
        const err = tc.error || (tc.result && tc.result.content && tc.result.content[0] && tc.result.content[0].text) || '';
        console.log(`  ERROR in ${tc.name || tc.tool}: ${String(err).slice(0, 120)}`);
      }
    });
  });
} else {
  // Dump top-level structure
  console.log(JSON.stringify(trace, null, 2).slice(0, 5000));
}
