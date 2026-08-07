// Confirms the hierarchical S#·C# numbering flows through the live API end-to-end.
// (a) unit-tests the lib; (b) GETs /scenarios and checks the labels are present.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { buildCaseNumbering } = require('../server/lib/caseNumbering');

const BASE = 'http://localhost:5000';
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };
function authHeaders() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '1h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { 'Cookie': `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}
let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fails++; };

// ── (a) lib unit test: 2 scenarios, cases out of createdAt order ──
const synthetic = [
  { id: 'sB', generationId: 'g1', priority: 'medium', createdAt: '2026-01-02', cases: [
    { id: 'cB2', createdAt: '2026-01-02T02:00' }, { id: 'cB1', createdAt: '2026-01-02T01:00' } ] },
  { id: 'sA', generationId: 'g1', priority: 'high', createdAt: '2026-01-01', cases: [
    { id: 'cA1', createdAt: '2026-01-01T01:00' } ] },
];
const num = buildCaseNumbering(synthetic);
ok(num.scenarioLabelById.get('sA') === 'S1', 'lib: high-priority/earliest scenario = S1');
ok(num.scenarioLabelById.get('sB') === 'S2', 'lib: next scenario = S2');
ok(num.caseLabelById.get('cA1') === 'S1 · C1', 'lib: sA case = S1 · C1');
ok(num.caseLabelById.get('cB1') === 'S2 · C1', 'lib: earliest case in sB = S2 · C1');
ok(num.caseLabelById.get('cB2') === 'S2 · C2', 'lib: later case in sB = S2 · C2');

// ── (b) live API ──
(async () => {
  try {
    const res = await fetch(`${BASE}/api/projects/${PROJECT}/scenarios`, { headers: authHeaders() });
    const body = await res.json();
    const scns = body.scenarios || [];
    ok(scns.length > 0, `API returned ${scns.length} scenario(s)`);
    if (scns.length) {
      ok(/^S\d+$/.test(scns[0].scenarioLabel || ''), `scenario[0].scenarioLabel = ${scns[0].scenarioLabel}`);
      const c0 = (scns[0].cases || [])[0];
      ok(c0 && /^S\d+ · C\d+$/.test(c0.caseLabel || ''), `case[0].caseLabel = ${c0?.caseLabel}`);
      // sanity: labels unique across all cases
      const labels = scns.flatMap((s) => (s.cases || []).map((c) => c.caseLabel));
      ok(new Set(labels).size === labels.length, `all ${labels.length} case labels unique`);
    }
  } catch (e) { console.log('  FAIL  API call threw: ' + e.message); fails++; }
  finally { await prisma.$disconnect(); console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} FAILED`); process.exit(fails ? 1 : 0); }
})();
