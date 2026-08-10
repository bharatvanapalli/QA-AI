const fs = require('fs');
const path = require('path');
const runId = '111af6e4-18a0-4141-b8e6-87c96ffd8ae7';
const tcId = '86398d13-d6b2-4330-8a96-c95dfd217da9';
const logsDir = path.join(__dirname, 'playwright/controller-journal');

let found = null;
for (const dir of fs.readdirSync(logsDir)) {
  const dirPath = path.join(logsDir, dir);
  if (fs.statSync(dirPath).isDirectory()) {
    for (const file of fs.readdirSync(dirPath)) {
      if (file.endsWith('.jsonl')) {
        const filePath = path.join(dirPath, file);
        const lines = fs.readFileSync(filePath, 'utf8').split('\n');
        for (const line of lines) {
          if (line.includes(runId) && line.includes(tcId)) {
            found = filePath;
            break;
          }
        }
      }
      if (found) break;
    }
  }
  if (found) break;
}

if (found) {
  console.log('Found log:', found);
  const lines = fs.readFileSync(found, 'utf8').split('\n');
  const evaluateEvents = lines.filter(l => l.includes('SEMANTIC_EVALUATE_ACKNOWLEDGMENT'));
  console.log('Evaluate events:');
  evaluateEvents.forEach(l => console.log(l));
} else {
  console.log('Log not found.');
}
