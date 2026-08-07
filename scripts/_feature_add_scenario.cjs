'use strict';
// Functional validation of the "+ Add scenario" feature (appendToCurrent + journey).
// POSTs a 25-step composite journey design to /generate and proves it APPENDS to the
// CURRENT generation as a pending, grounded case with typed verify + (where applicable) data binding.
const path = require('path'); const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const jwt = require(path.join(ROOT, 'server', 'node_modules', 'jsonwebtoken'));
const { PrismaClient } = require(path.join(ROOT, 'server', 'node_modules', '@prisma', 'client')); const p = new PrismaClient();

const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93'; // OrangeHRM
const BASE = 'http://localhost:5000'; const CSRF = 'feat-csrf';

const DESIGN = [
  'Composite admin user-lifecycle journey (treat as ONE end-to-end benchmark case, do NOT split):',
  '1. Log in as Admin. 2. Open the Admin menu. 3. Go to User Management > Users.',
  '4. Click Add. 5. Open the User Role dropdown and select ESS. 6. Open the Status dropdown and select Enabled.',
  '7. In the Employee Name autocomplete, type a name and pick the first suggestion.',
  '8. Enter a Username. 9. Enter a Password. 10. Confirm the Password. 11. Click Save.',
  '12. Verify the new user appears in the Users list (search by the username). 13. Log out.',
  '14. Verify redirect back to the login page. 15. Log in as the newly created ESS user.',
  '16. Verify the ESS dashboard loads (no Admin menu visible). 17. Open the user dropdown. 18. Log out again.',
  'Use the verified Site Atlas for every locator and bind the uploaded test data where a username/password/role is needed.',
].join('\n');

(async () => {
  const proj = await p.project.findUnique({ where: { id: PID }, select: { userId: true } });
  const user = await p.user.findUnique({ where: { id: proj.userId }, select: { id: true, email: true, role: true } });
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role || 'user' }, process.env.JWT_SECRET, { expiresIn: '3h' });
  const H = { 'Content-Type': 'application/json', 'x-xsrf-token': CSRF, Cookie: `token=${token}; XSRF-TOKEN=${CSRF}` };

  const genBefore = await p.scenarioGeneration.findFirst({ where: { projectId: PID, isCurrent: true }, orderBy: { version: 'desc' }, select: { id: true, version: true, scenarioCount: true, caseCount: true, label: true } });
  console.log(`BEFORE current gen: v${genBefore.version} id=${genBefore.id} scenarios=${genBefore.scenarioCount} cases=${genBefore.caseCount}`);

  console.log('POST /scenarios/generate {appendToCurrent:true, journey:true} … (architect LLM, may take ~1-3 min)');
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
  let body;
  try {
    const r = await fetch(`${BASE}/api/projects/${PID}/scenarios/generate`, {
      method: 'POST', headers: H, signal: ctrl.signal,
      body: JSON.stringify({ appendToCurrent: true, journey: true, sessionGuidance: DESIGN }),
    });
    body = await r.json().catch(() => ({}));
    console.log(`/generate → HTTP ${r.status} success=${body.success} generationId=${body.generationId} scenarios=${(body.scenarios || []).length}`);
  } catch (e) { console.log('generate ERR ' + e.message); await p.$disconnect(); process.exit(1); }
  clearTimeout(t);

  // ---- ASSERTIONS ----
  const reusedGen = body.generationId === genBefore.id;
  console.log(`\n[1] APPENDED to current gen (no new gen)?  ${reusedGen ? 'YES ✓' : 'NO — new gen ' + body.generationId + ' ✗'}`);

  const genAfter = await p.scenarioGeneration.findUnique({ where: { id: genBefore.id }, select: { scenarioCount: true, caseCount: true } });
  console.log(`[2] counts incremented?  scenarios ${genBefore.scenarioCount}→${genAfter.scenarioCount}  cases ${genBefore.caseCount}→${genAfter.caseCount}`);

  const newScens = body.scenarios || [];
  console.log(`[3] new scenario(s) returned: ${newScens.length} (capped at 5)`);
  for (const s of newScens) {
    const caseN = (s.cases || []).length;
    console.log(`    • "${s.name}" [${s.category}/${s.priority}] cases=${caseN}`);
  }

  // Pull the freshest persisted cases for the new scenario(s) from the DB (source of truth).
  const newScenIds = newScens.map((s) => s.id).filter(Boolean);
  if (newScenIds.length) {
    const dbCases = await p.testCase.findMany({
      where: { scenarioId: { in: newScenIds } },
      select: { id: true, name: true, status: true, steps: true, dataBindingJson: true, requiresData: true, producesData: true, type: true },
    });
    let withVerify = 0, totalSteps = 0, stepsWithVerify = 0, withBinding = 0, longest = 0;
    for (const c of dbCases) {
      let steps = []; try { steps = JSON.parse(c.steps || '[]'); } catch {}
      totalSteps += steps.length; longest = Math.max(longest, steps.length);
      const sv = steps.filter((st) => st && st.verify && st.verify.kind).length;
      stepsWithVerify += sv; if (sv > 0) withVerify++;
      if (c.dataBindingJson && c.dataBindingJson !== 'null' && c.dataBindingJson !== '[]') withBinding++;
    }
    const pending = dbCases.filter((c) => String(c.status) === 'pending' || String(c.status) === 'draft').length;
    console.log(`\n[4] persisted cases: ${dbCases.length}  | longest case = ${longest} steps  | totalSteps=${totalSteps}`);
    console.log(`[5] cases landed PENDING/draft (need approval): ${pending}/${dbCases.length}`);
    console.log(`[6] typed verify present: ${withVerify}/${dbCases.length} cases, ${stepsWithVerify}/${totalSteps} steps carry verify.kind`);
    console.log(`[7] data binding present: ${withBinding}/${dbCases.length} cases bound to test data`);
    // Show the verify-kind histogram across the new steps + a sample step
    const hist = {};
    let sample = null;
    for (const c of dbCases) {
      let steps = []; try { steps = JSON.parse(c.steps || '[]'); } catch {}
      for (const st of steps) { const k = st?.verify?.kind || 'none'; hist[k] = (hist[k] || 0) + 1; if (!sample && st?.verify?.kind && st.verify.kind !== 'none') sample = st; }
    }
    console.log(`[8] verify.kind histogram: ${JSON.stringify(hist)}`);
    if (sample) console.log(`    sample step: action=${sample.action} stepKind=${sample.stepKind} verify=${JSON.stringify(sample.verify).slice(0, 200)}`);
  } else {
    console.log('\n[4-8] no scenario ids in response — cannot inspect persisted cases');
  }

  await p.$disconnect();
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
