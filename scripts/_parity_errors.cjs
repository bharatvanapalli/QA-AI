'use strict';
const path = require('path');
const fs = require('fs');
const file = process.argv[2] || path.join(__dirname,'..','..','_parity','707ba2ac','results.json');
const r = JSON.parse(fs.readFileSync(file,'utf8'));
const out = [];
const walk = (s) => {
  for (const sp of s.suites||[]) walk(sp);
  for (const sp of s.specs||[]) {
    const t = sp.tests?.[0]; const res = (t?.results)||[]; const last = res[res.length-1];
    const status = last?.status || t?.status || '?';
    let msg = '';
    if (status !== 'passed') {
      const errs = (last?.errors||[]).map(e => e.message||'').join(' | ') || (last?.error?.message||'');
      msg = String(errs).replace(/\[[0-9;]*m/g,'').replace(/\s+/g,' ').slice(0, 220);
    }
    out.push({ status, title: sp.title, msg });
  }
};
for (const s of r.suites||[]) walk(s);
for (const o of out) {
  console.log(`\n[${o.status}] ${o.title}`);
  if (o.msg) console.log(`   ${o.msg}`);
}
console.log(`\n${out.filter(o=>o.status==='passed').length}/${out.length} passed`);
