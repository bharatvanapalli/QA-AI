const fs = require('fs');
const lines = fs.readFileSync('server/services/controllerTypedAdapterRegistry.js', 'utf8').split('\n');
lines.forEach((l, i) => {
  if (l.includes('browser_evaluate')) {
    console.log(i + ': ' + l.trim());
  }
});
