const fs = require('fs');
const dataStr = JSON.parse(fs.readFileSync('./scratch/verify_run_results6.json', 'utf8'));
const data = JSON.parse(dataStr);
data.forEach(step => {
  if (step.status === 'fail') {
    console.log(`Step ${step.index} FAILED:`, step.reason, step.executionError);
    if (step.actionTransaction) {
      console.log(`  Transaction reason:`, step.actionTransaction.reason);
    }
  }
});
