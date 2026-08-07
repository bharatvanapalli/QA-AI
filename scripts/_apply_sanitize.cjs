const fs = require('fs'); const path = require('path');
const { sanitizeGenerated } = require('../server/services/codegen/_sanitize');
const root = process.argv[2];
function walk(d){ for(const e of fs.readdirSync(d,{withFileTypes:true})){ const p=path.join(d,e.name); if(e.isDirectory()){ if(e.name==='node_modules') continue; walk(p);} else if(/\.(ts|js)$/.test(e.name) && !p.includes('node_modules')){ const c=fs.readFileSync(p,'utf8'); const s=sanitizeGenerated(c,e.name); if(s!==c){ fs.writeFileSync(p,s,'utf8'); console.log('  fixed', path.relative(root,p)); } } } }
walk(root);
console.log('sanitize pass complete');
