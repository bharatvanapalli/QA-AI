const fs = require('fs');
const path = require('path');
const RUN_ID = 'f0623881-304b-4bbb-a95d-911481720872';
const dir = path.join(process.cwd(), 'playwright', 'controller-journal', RUN_ID);
const files = fs.readdirSync(dir);
const file = files.find(f => f.endsWith('.jsonl'));
if (file) {
  const content = fs.readFileSync(path.join(dir, file), 'utf8');
  const lines = content.split('\n').filter(Boolean);
  lines.forEach(l => {
    const j = JSON.parse(l);
    let time = j.recordedAt;
    if (j.facts && j.facts.recordedAt) time = j.facts.recordedAt;
    let desc = `${j.eventType || j.recordKind}`;
    if (j.facts && j.facts.operationId) desc += ` op=${j.facts.operationId} phase=${j.facts.phase}`;
    if (j.facts && j.facts.toolName) desc += ` tool=${j.facts.toolName}`;
    if (j.facts && j.facts.reason) desc += ` reason=${j.facts.reason}`;
    console.log(`${time} - ${desc}`);
  });
}
