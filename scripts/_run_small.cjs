require('dotenv').config();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const BASE = 'http://localhost:5000';
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const GEN = '5a5c2bcd-2956-4957-ba71-9b7646c4a74e';
const PICK = ['40f68729', '8a7ddaa6', '6236dc4c']; // id prefixes
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };
function headers() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { 'Content-Type': 'application/json', Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}
(async () => {
  const scns = await prisma.testScenario.findMany({ where: { projectId: PROJECT, generationId: GEN }, include: { cases: true } });
  const all = scns.flatMap(s => s.cases);
  const picked = all.filter(c => PICK.some(p => c.id.startsWith(p)));
  console.log('picked', picked.length, 'cases:'); picked.forEach(c => console.log('  -', c.name.slice(0,60)));
  if (picked.length !== 3) { console.log('expected 3, got', picked.length, '— aborting'); process.exit(1); }
  // current-gen: everything pending, then approve exactly the 3
  await prisma.testCase.updateMany({ where: { id: { in: all.map(c=>c.id) } }, data: { status: 'pending' } });
  await prisma.testCase.updateMany({ where: { id: { in: picked.map(c=>c.id) } }, data: { status: 'approved' } });
  console.log('approval set: 3 approved, rest pending (current gen only)');
  const ex = await fetch(`${BASE}/api/projects/${PROJECT}/agents/execute`, { method: 'POST', headers: headers(), body: JSON.stringify({}) });
  const body = await ex.json().catch(()=>({}));
  console.log(`execute → ${ex.status}  ${JSON.stringify(body).slice(0,400)}`);
})().catch(e=>console.error('ERR', e.message)).finally(()=>prisma.$disconnect());
