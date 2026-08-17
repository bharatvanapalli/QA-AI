const fs = require('fs');

const raw = fs.readFileSync('.qaai-runtime/scenario-generation-jobs.json', 'utf8');

const matches = raw.match(/\"caseContractV1\"\s*:\s*\{[^\}]+\"steps\"\s*:\s*\[[^\]]+\]/gi) || [];
console.log('Regex caseContractV1 matches:', matches.length);

const contracts = [];

// Deep traversal of JSON object
function findContracts(obj) {
  if (!obj || typeof obj !== 'object') return;

  if (obj.caseContractV1 && obj.caseContractV1.steps) {
    contracts.push(obj.caseContractV1);
  } else if (obj.steps && Array.isArray(obj.steps) && obj.steps.length > 0 && obj.steps[0].authoredText) {
    contracts.push(obj);
  }

  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'string' && (k === 'qualityContractJson' || obj[k].includes('caseContractV1'))) {
      try {
        const parsed = JSON.parse(obj[k]);
        findContracts(parsed);
      } catch (e) {}
    } else if (typeof obj[k] === 'object') {
      findContracts(obj[k]);
    }
  }
}

const data = JSON.parse(raw);
findContracts(data);

console.log('Total extracted case contracts:', contracts.length);

const uniqueMap = new Map();
for (const c of contracts) {
  const key = c.name || c.intent || (c.steps[0] && c.steps[0].authoredText);
  if (key && !uniqueMap.has(key)) {
    uniqueMap.set(key, c);
  }
}

const uniqueContracts = Array.from(uniqueMap.values());
console.log('Unique case contracts extracted:', uniqueContracts.length);

if (uniqueContracts.length > 0) {
  console.log('Sample contract name:', uniqueContracts[0].name || uniqueContracts[0].intent);
  console.log('Sample steps count:', uniqueContracts[0].steps.length);
  console.log('Sample step text:', uniqueContracts[0].steps.map(s => s.authoredText || s.text));
}
