const fs = require('fs');
const text = fs.readFileSync('server/services/controllerMcpRuntimeAdapter.js', 'utf8');
console.log(text.includes('case \'browser_evaluate\':'));
console.log(text.includes('if (sdkToolName === \'browser_evaluate\')'));
