// Approve ONLY the current-generation automatable cases (surgical — no
// cross-generation side effects), then trigger the conductor+verdict engine via
// POST /agents/execute. This is the SAME engine the UI "Run" button uses (NOT
// the legacy runs.js path), so it exercises the declaredAssertions → conductor
// assertion_check → computeVerdict pipeline we just fixed (PAGE musts live).
require('dotenv').config();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const BASE = 'http://localhost:5000';
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const GEN = process.argv[2] || '5a5c2bcd-2956-4957-ba71-9b7646c4a74e';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };
function headers() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { 'Content-Type': 'application/json', Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}
(async () => {
  try {
    const scns = await prisma.testScenario.findMany({ where: { projectId: PROJECT, generationId: GEN }, include: { cases: true } });
    const ids = scns.flatMap((s) => s.cases).filter((c) => (c.automatability || 'automatable') === 'automatable').map((c) => c.id);
    console.log(`v3 automatable cases to approve: ${ids.length}`);

    const ap = await fetch(`${BASE}/api/projects/${PROJECT}/test-cases/bulk-update`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ ids, status: 'approved' }),
    });
    const apBody = await ap.json().catch(() => ({}));
    console.log(`bulk-update → ${ap.status}  approved=${apBody.updated}`);
    if (!ap.ok) { console.log(JSON.stringify(apBody)); process.exit(1); }

    const ex = await fetch(`${BASE}/api/projects/${PROJECT}/agents/execute`, {
      method: 'POST', headers: headers(), body: JSON.stringify({}),
    });
    const exBody = await ex.json().catch(() => ({}));
    console.log(`execute → ${ex.status}  ${JSON.stringify(exBody).slice(0, 300)}`);
  } catch (e) { console.error('ERR', e.message); } finally { await prisma.$disconnect(); process.exit(0); }
})();
