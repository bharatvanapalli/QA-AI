const fs = require('node:fs');
const resolver = require('./server/services/actionLocatorResolver');

const snapshot = fs.readFileSync('.playwright-mcp/page-2026-07-20T02-56-23-292Z.yml', 'utf8');
for (const label of ['Microsoft password field', 'Password field', 'Enter password']) {
  const result = resolver.resolveSemanticActionTarget(snapshot, {
    label,
    roleHints: ['textbox', 'combobox', 'searchbox'],
    semanticTarget: { kind: 'control', name: label },
  });
  console.log(label, JSON.stringify(result, null, 2));
}
