const fs = require('fs');

const raw = fs.readFileSync('.qaai-runtime/scenario-generation-jobs.json', 'utf8');
const data = JSON.parse(raw);

console.log('Total jobs:', Object.keys(data.jobs || {}).length);

const foundCases = [];
const foundScenarios = [];

function searchObj(obj, path = '') {
  if (!obj || typeof obj !== 'object') return;

  if (obj.title || obj.name) {
    const text = (obj.title || obj.name || '') + ' ' + (obj.description || '') + ' ' + (obj.specCode || '');
    if (text.toLowerCase().includes('letcode') || text.toLowerCase().includes('button') || text.toLowerCase().includes('form') || text.toLowerCase().includes('dialog')) {
      if (obj.specCode || obj.assertions || obj.type === 'ui_functional') {
        foundCases.push(obj);
      } else if (obj.priority || obj.flowType || obj.rationale) {
        foundScenarios.push(obj);
      }
    }
  }

  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object') {
      searchObj(obj[key], path + '.' + key);
    }
  }
}

searchObj(data.jobs);

console.log('Found test cases:', foundCases.length);
console.log('Found scenarios:', foundScenarios.length);
if (foundCases.length > 0) {
  console.log('Sample case:', foundCases[0].name || foundCases[0].title);
}
