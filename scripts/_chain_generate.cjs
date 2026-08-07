// CHAIN STEP B1 — regenerate the AUTH module (Focus) on project 465f2d08 against the freshly
// recalibrated atlas. groundCaseAssertions runs in persistCases at generation, so this is what
// demotes the guessed negative-validation text (Class C). Versioned — preserves run 707ba2ac.
require('dotenv').config();
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
const focusArea = 'Authentication and Login — login form validation (empty username, empty password, both fields empty), invalid-credentials handling, password field masking, SQL injection and XSS in the login fields, successful admin login, logout and session termination, and role-based access (ESS vs Admin)';
const directive = 'FOCUS suite — generate scenarios ONLY for the functionality named in [FOCUS AREA], and cover THAT functionality exhaustively (positive, negative, edge, boundary, security). Do NOT generate scenarios for any other module.';
const sessionGuidance = `[GENERATION MODE — Focus]: ${directive}\n[FOCUS AREA]: ${focusArea}`;
(async () => {
  const t0 = Date.now();
  console.log('POST /scenarios/generate (Focus → Authentication/Login) — Architect runs synchronously…');
  const res = await fetch(`${BASE}/api/projects/${PROJECT}/scenarios/generate`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ replace: true, sessionGuidance }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`→ ${res.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (body.stats) console.log(`scenarios=${body.stats.scenarios} cases=${body.stats.cases} generationId=${body.generationId} v${body.generationVersion}`);
  else console.log(JSON.stringify(body).slice(0, 600));
  process.exit(res.ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
