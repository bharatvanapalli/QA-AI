'use strict';
const zlib = require('zlib');
const fs = require('fs');

const traceFile = 'C:\\Users\\2461898\\Downloads\\qaai_fixed\\qaai_fixed\\qaai_fixed\\playwright\\telemetry\\d84e3a57-f3c4-4c7a-9dd1-fd294edd12ce\\pending-cc13d9c4-862c-4243-ad7a-e348c37b9beb.json.gz';

const compressed = fs.readFileSync(traceFile);
const raw = zlib.gunzipSync(compressed).toString('utf8');
const trace = JSON.parse(raw);

// Inspect first turn structure
console.log('=== TRACE TOP LEVEL ===');
console.log('schemaVersion:', trace.schemaVersion);
console.log('testCaseName:', trace.testCaseName);
console.log('execMode:', trace.execMode);
console.log('totalElapsedMs:', trace.totalElapsedMs);
console.log('stabilityCapHits:', trace.stabilityCapHits);
console.log('assertionPolls:', trace.assertionPolls);
console.log('Total turns:', trace.turns.length);

console.log('\n=== TURN 0 KEYS ===');
const t0 = trace.turns[0];
console.log(Object.keys(t0).join(', '));
console.log('Turn 0 sample:', JSON.stringify(t0, null, 2).slice(0, 1500));

console.log('\n=== TURN 12 (the failing step) ===');
const t12 = trace.turns[12];
console.log(JSON.stringify(t12, null, 2).slice(0, 2000));
