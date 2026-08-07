const r = require('C:/Users/2461898/Downloads/qaai_fixed/qaai_fixed/_parity/707ba2ac/results.json');
const walk = (s) => {
  for (const c of s.suites || []) walk(c);
  for (const sp of s.specs || []) {
    if (!String(s.file || '').includes('logout-session')) continue;
    const res = (sp.tests && sp.tests[0] && sp.tests[0].results) || [];
    res.forEach((rr, i) => {
      const errs = (rr.errors || []).map((e) => String(e.message || '').replace(/\[[0-9;]*m/g, '').replace(/\s+/g, ' ').slice(0, 260)).join(' || ');
      console.log(`attempt ${i} [${rr.status}] :: ${errs || '(no error)'}`);
    });
  }
};
for (const s of r.suites || []) walk(s);
