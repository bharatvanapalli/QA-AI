// Fires a MODULE-SCOPED (Focus-mode) scenario regeneration against the live
// atlas — the real QA unit of work (one module: ~12-15 scenarios / ~50-60
// cases), which fits the token budget and matches how testers actually work.
// Usage: node scripts/_run_generate.cjs ["Focus area / module name"]
require('dotenv').config();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const BASE = 'http://localhost:5000';
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };
function headers() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '2h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { 'Content-Type': 'application/json', Cookie: `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}
const focusArea = process.argv[2]
  || 'PIM (Personnel Information Management) — add employee, employee list/search, and the employee detail tabs (personal details, contact details, emergency contacts)';
const directive = 'FOCUS suite — generate scenarios ONLY for the functionality named in [FOCUS AREA], and cover THAT functionality exhaustively (positive, negative, edge, boundary, and security where it applies). Do NOT generate scenarios for any other module or feature.';
const sessionGuidance = `[GENERATION MODE — Focus]: ${directive}\n[FOCUS AREA]: Prioritize these flows above all others: ${focusArea}`;
(async () => {
  const t0 = Date.now();
  console.log(`POST /scenarios/generate (Focus → "${focusArea.slice(0, 60)}…") — Architect runs synchronously…`);
  const res = await fetch(`${BASE}/api/projects/${PROJECT}/scenarios/generate`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ replace: true, sessionGuidance }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`→ ${res.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (body.stats) console.log(`scenarios=${body.stats.scenarios} cases=${body.stats.cases} generationId=${body.generationId} v${body.generationVersion}`);
  else console.log(JSON.stringify(body).slice(0, 500));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
