const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };
function h() {
  const t = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const c = crypto.randomBytes(16).toString('hex');
  return { Cookie: `token=${t}; XSRF-TOKEN=${c}`, 'x-xsrf-token': c };
}
(async () => {
  const r = await fetch('http://localhost:5000/api/runs?projectId=465f2d08-c8b5-469a-af41-9c0ba2a2ce93&limit=2', { headers: h() });
  const d = await r.json();
  d.runs.slice(0,2).forEach(run => console.log(`${run.id} ${run.status} pass=${run.passed} fail=${run.failed} blocked=${run.blocked}`));
})().catch(e => console.error(String(e)));