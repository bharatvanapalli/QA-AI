// (1) Clear any orphaned 'running' run left by the killed conductor, then
// (2) trigger POST /open-in-vscode so the operator's workspace folder is
// re-copied CLEANLY (the fixed handler clears generated subtrees first).
require('dotenv').config();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const BASE = 'http://localhost:5000';
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };
function headers() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { 'Content-Type': 'application/json', Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}
(async () => {
  try {
    const upd = await prisma.run.updateMany({ where: { projectId: PROJECT, status: 'running' }, data: { status: 'cancelled' } });
    console.log('orphan running runs cancelled:', upd.count);
    const res = await fetch(`${BASE}/api/projects/${PROJECT}/output-files/open-in-vscode`, { method: 'POST', headers: headers(), body: JSON.stringify({}) });
    const body = await res.json().catch(() => ({}));
    console.log(`open-in-vscode → ${res.status}  ${JSON.stringify(body)}`);
  } catch (e) { console.error('ERR', e.message); } finally { await prisma.$disconnect(); process.exit(0); }
})();
