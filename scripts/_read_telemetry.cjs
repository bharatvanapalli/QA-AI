const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function readGz(filePath) {
  const buf = fs.readFileSync(filePath);
  return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
}

function printTelemetry(data) {
  console.log('testCase:', data.testCaseName);
  console.log('totalElapsedMs:', data.totalElapsedMs);
  console.log('stabilityCapHits:', data.stabilityCapHits);
  console.log('turns:', data.turns?.length || 0);
  for (const turn of (data.turns || [])) {
    console.log('\n  --- Turn', turn.index, '| stop:', turn.stopReason, '| ms:', turn.elapsedMs, '| tokens in/out:', (turn.usage?.inputTokens||0)+'/'+(turn.usage?.outputTokens||0));
    if (turn.assistantText) console.log('  THINK:', turn.assistantText.substring(0, 300));
    for (const tu of (turn.toolUses || [])) {
      const inp = JSON.stringify(tu.input || {});
      console.log('  CALL', tu.name + ':', inp.substring(0, 200));
    }
    for (const tr of (turn.toolResults || [])) {
      let extra = '';
      if (tr.snapshotBytes > 0) extra += ' snap=' + tr.snapshotBytes;
      if (tr.errorPreview) extra += ' ERR=' + tr.errorPreview.substring(0, 100).replace(/\n/g,' ');
      if (tr.domFacts?.matched !== undefined) extra += ' matched=' + tr.domFacts.matched + ' reason=' + tr.domFacts.reason;
      console.log('  RES', tr.name, '| ok:', tr.ok, '| url:', (tr.pageUrlAfter||'').split('/').slice(-2).join('/') + extra);
    }
  }
}

const dir = process.argv[2];
const tcId = process.argv[3]; // optional filter

if (!dir) { console.error('usage: node _read_telemetry.cjs <dir> [tcId]'); process.exit(1); }

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json.gz'));
for (const f of files) {
  const tcPart = f.replace('pending-', '').replace('.json.gz', '');
  if (tcId && !tcPart.startsWith(tcId)) continue;
  console.log('\n\n========== FILE:', f, '==========');
  try {
    const data = readGz(path.join(dir, f));
    printTelemetry(data);
  } catch (e) {
    console.error('Error reading', f, ':', e.message);
  }
}
