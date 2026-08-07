// Triggers an authenticated calibration for OrangeHRM and polls to completion,
// then reports what the atlas captured (pages beyond login + text corpus).
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const BASE = 'http://localhost:5000';
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };
function headers() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '1h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { 'Content-Type': 'application/json', Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}
(async () => {
  const res = await fetch(`${BASE}/api/projects/${PROJECT}/calibrations`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ maxPages: 30 }),
  });
  const body = await res.json().catch(() => ({}));
  console.log('POST /calibrations →', res.status, JSON.stringify(body));
  const calId = body.id;
  if (!calId) { console.log('no calibrationId — aborting'); await prisma.$disconnect(); process.exit(1); }

  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 8000));
    const cal = await prisma.calibration.findUnique({ where: { id: calId }, include: { pages: true } });
    if (!cal) continue;
    const beyond = cal.pages.filter((p) => !/auth\/login\/?$/i.test(p.url) && !/\/auth\/login\?/i.test(p.url));
    console.log(`[${i * 8}s] status=${cal.status} pages=${cal.pages.length} beyond-login=${beyond.length}`);
    if (cal.status !== 'running') {
      console.log(`\n=== CALIBRATION ${cal.status.toUpperCase()} — ${cal.pages.length} pages ${cal.errorMessage ? '(err: ' + cal.errorMessage + ')' : ''} ===`);
      for (const p of cal.pages) {
        let tc = []; try { tc = JSON.parse(p.textCorpus || '[]'); } catch {}
        let els = []; try { els = JSON.parse(p.elementsJson || '[]'); } catch {}
        console.log(`  • [${p.pageRole || '?'}] ${p.url}`);
        console.log(`      elements=${els.length} text=${tc.length}: ${tc.slice(0, 14).join(' | ')}`);
      }
      console.log(`\nlogin succeeded (mapped pages beyond login): ${cal.pages.some((p) => /\/(pim|admin|leave|dashboard|recruitment)/i.test(p.url))}`);
      console.log(`addEmployee mapped: ${cal.pages.some((p) => /addEmployee/i.test(p.url))}`);
      console.log(`any page shows "First Name": ${cal.pages.some((p) => /first name/i.test(p.textCorpus || ''))}`);
      break;
    }
  }
  await prisma.$disconnect(); process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
