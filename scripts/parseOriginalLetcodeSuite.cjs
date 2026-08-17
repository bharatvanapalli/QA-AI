const fs = require('fs');

const raw = fs.readFileSync('.qaai-runtime/scenario-generation-jobs.json', 'utf8');
const data = JSON.parse(raw);
const jobs = Object.values(data.jobs || {});
const letcodeJob = jobs.find(j => JSON.stringify(j).toLowerCase().includes('letcode'));

const allCases = [];

if (letcodeJob && letcodeJob.snapshots) {
  for (const snap of letcodeJob.snapshots) {
    if (snap.data && snap.data.cases) {
      for (const c of snap.data.cases) {
        if (c.qualityContractJson || c.declaredAssertions) {
          try {
            let contract = null;
            if (c.qualityContractJson) {
              const qc = typeof c.qualityContractJson === 'string' ? JSON.parse(c.qualityContractJson) : c.qualityContractJson;
              contract = qc.caseContractV1 || qc;
            }
            allCases.push({
              id: c.id,
              name: c.name || contract?.name || 'Test Case',
              module: c.module || contract?.module || 'General',
              contract: contract,
              steps: contract?.steps || c.steps || [],
              assertions: c.declaredAssertions || contract?.assertions || c.assertions || [],
              specCode: c.specCode || null,
            });
          } catch (e) {}
        }
      }
    }
  }
}

console.log('Total original LetCode case contracts extracted:', allCases.length);
if (allCases.length > 0) {
  console.log('Sample case name:', allCases[0].name);
  console.log('Sample steps count:', allCases[0].steps.length);
  console.log('Sample first step:', allCases[0].steps[0]);
}
