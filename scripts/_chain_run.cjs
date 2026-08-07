// CHAIN STEP B2 — run ONLY the negative-validation cases of the freshly regenerated auth gen
// (bounded cost) to produce new grounded IR. Approves just those in the current gen, executes.
require('dotenv').config();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const BASE = 'http://localhost:5000';
const PROJECT = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };
const NEG = /empty (user|pass)|both fields empty|invalid (cred|username)|wrong password|sql injection/i;
function headers() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { 'Content-Type': 'application/json', Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}
(async () => {
  const gen = (await prisma.scenarioGeneration.findMany({ where: { projectId: PROJECT }, orderBy: { createdAt: 'desc' }, take: 1 }))[0];
  const scns = await prisma.testScenario.findMany({ where: { generationId: gen.id }, include: { cases: true } });
  const all = scns.flatMap((s) => s.cases);
  const picked = all.filter((c) => NEG.test(c.name || ''));
  console.log(`gen v${gen.version} ${gen.id.slice(0,10)} — ${all.length} cases, picking ${picked.length} negative-validation:`);
  picked.forEach((c) => console.log('  - ' + c.name.slice(0, 64)));
  if (!picked.length) { console.log('no negative cases matched — aborting'); process.exit(1); }
  await prisma.testCase.updateMany({ where: { id: { in: all.map((c) => c.id) } }, data: { status: 'pending' } });
  await prisma.testCase.updateMany({ where: { id: { in: picked.map((c) => c.id) } }, data: { status: 'approved' } });
  console.log(`approved ${picked.length}, rest pending (current gen only)`);
  const ex = await fetch(`${BASE}/api/projects/${PROJECT}/agents/execute`, { method: 'POST', headers: headers(), body: JSON.stringify({}) });
  const body = await ex.json().catch(() => ({}));
  console.log(`execute → ${ex.status}  ${JSON.stringify(body).slice(0, 300)}`);
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
