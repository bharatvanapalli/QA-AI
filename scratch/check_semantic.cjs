const fs = require('fs');
const lines = fs.readFileSync('server/services/controllerTypedAdapterRegistry.js', 'utf8').split('\n');
const idx = lines.findIndex(l => l.includes('Semantic'));
if (idx !== -1) console.log(lines.slice(Math.max(0, idx-10), idx+30).join('\n'));
