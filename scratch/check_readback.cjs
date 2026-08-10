const fs = require('fs');
const path = require('path');
const RUN_ID = '2d7b7b12-2176-424e-90a1-2b8a19d21bb5';

const dir = path.join(process.cwd(), 'playwright', 'controller-journal', RUN_ID);
const files = fs.readdirSync(dir);
const file = files.find(f => f.endsWith('.jsonl'));
if (file) {
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\n/).filter(Boolean);
  lines.forEach(l => {
    const j = JSON.parse(l);
    if (j.factId === 'fact:controller-dom-readback:text-input:a1c4b8f2-4ea1-4177-a83c-3e28f97db619') {
      console.log('Readback:', JSON.stringify(j.payload || j, null, 2));
    }
  });
}
