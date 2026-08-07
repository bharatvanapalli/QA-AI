// CHAIN STEP A — authenticated calibration of the run-707ba2ac project (465f2d08), polled to
// completion. Grounds the atlas with the live site's real text so the grounding gate can demote
// the guessed negative-validation strings (Class C). Spends Claude tokens (authorized).
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const BASE = 'http://localhost:5000';
const PROJECT = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };
function headers() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { 'Content-Type': 'application/json', Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}
(async () => {
  const res = await fetch(`${BASE}/api/projects/${PROJECT}/calibrations`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ maxPages: 20 }),
  });
  const body = await res.json().catch(() => ({}));
  console.log('POST /calibrations →', res.status, JSON.stringify(body).slice(0, 200));
  const calId = body.id;
  if (!calId) { console.log('no calibrationId — aborting'); await prisma.$disconnect(); process.exit(1); }

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 8000));
    const cal = await prisma.calibration.findUnique({ where: { id: calId }, include: { pages: true } }).catch(() => null);
    if (!cal) continue;
    process.stdout.write(`[${i * 8}s] status=${cal.status} pages=${cal.pages.length}\n`);
    if (cal.status !== 'running') {
      console.log(`\n=== CALIBRATION ${String(cal.status).toUpperCase()} — ${cal.pages.length} pages ${cal.errorMessage ? '(err: ' + cal.errorMessage + ')' : ''} ===`);
      for (const pg of cal.pages) {
        let tc = []; try { tc = JSON.parse(pg.textCorpus || '[]'); } catch {}
        console.log(`  • [${pg.pageRole || '?'}] ${pg.url}  (text=${tc.length})`);
      }
      const loginPage = cal.pages.find((pg) => /auth\/login/i.test(pg.url));
      if (loginPage) { let tc=[]; try{tc=JSON.parse(loginPage.textCorpus||'[]')}catch{}; console.log(`\nlogin-page corpus sample: ${tc.slice(0,20).join(' | ')}`); }
      break;
    }
  }
  await prisma.$disconnect(); process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
