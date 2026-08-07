'use strict';
/**
 * Convergence proof: regenerate a DIVERSE set of per-case specs through the
 * CURRENT (fixed) pipeline and run them. If different scripts pass with the
 * SAME generic fixes, the fixes are population-level, not per-case.
 * Writes into the already-installed dir (no wipe, reuses node_modules).
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const codegen = require('../server/services/codegen');
const envContract = require('../server/services/codegen/_env');
const loginLib = require('../server/services/codegen/_login');
const locatorsLib = require('../server/services/codegen/_locators');
const { reconstructTrail, buildActionPlan } = require('../server/services/codegen/_replayTrace');
const { resolveAiCredentials } = require('../server/lib/resolveAiCredentials');
const { getProvider } = require('../server/lib/llmProvider');
const { elementLabelFromArgs } = require('../server/services/agents/conductor');

const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const USER = 'a5d916cd-4178-4bcc-b409-c885a389e843';
const DIR = path.join(__dirname, '..', 'playwright', 'refit', 'ae36bfe8-97f5-4252-b42f-551971423b08');
const N = Number((process.argv.find((a) => a.startsWith('--n=')) || '').split('=')[1] || 5);
const RUN = process.argv.includes('--run');
const safeParse = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : (s || null); } catch (_) { return null; } };

(async () => {
  const project = await prisma.project.findUnique({ where: { id: PROJECT }, select: { framework: true, targetUrl: true, testCredentials: true } });
  const framework = 'playwright-pom';
  const targetUrl = project.targetUrl;
  const run = await prisma.run.findFirst({ where: { projectId: PROJECT, id: { startsWith: 'ae36bfe8' } }, select: { id: true } });
  const rrs = await prisma.runResult.findMany({
    where: { runId: run.id, richTraceFile: { not: null }, status: 'pass' },
    select: { status: true, richTraceFile: true, stepResults: true,
      testCase: { select: { id: true, name: true, type: true, steps: true, declaredAssertions: true,
        scenario: { select: { name: true, module: true, category: true } } } } },
  });
  // Diversity: one case per distinct scenario, with a non-empty trail.
  const seen = new Set(); const picks = [];
  for (const r of rrs) {
    if (!r.testCase || reconstructTrail(r.richTraceFile).length === 0) continue;
    const key = r.testCase.scenario?.name || r.testCase.id;
    if (seen.has(key)) continue; seen.add(key); picks.push(r);
    if (picks.length >= N) break;
  }
  console.log(`Regenerating ${picks.length} DIVERSE passing cases through the fixed pipeline:\n`);
  picks.forEach((r, i) => console.log(`  ${i + 1}. ${r.testCase.name.slice(0, 60)}`));

  const kbRows = await prisma.knowledgeBaseLocator.findMany({ where: { projectId: PROJECT },
    select: { element: true, role: true, accessibleName: true, selector: true, strategy: true, healthScore: true, occurrences: true, pageUrl: true } });
  let firstLoginCtx = null;
  for (const r of rrs) { const t = reconstructTrail(r.richTraceFile); const ctx = loginLib.extractLoginContext({ actions: t.map((a) => ({ tool: a.tool, args: a.args })) }, targetUrl); if (ctx.observed?.username) { firstLoginCtx = ctx; break; } }
  const credProfile = envContract.buildCredentialProfile({ testCredentials: project.testCredentials, observed: firstLoginCtx?.observed });

  const { provider: providerName, apiKey, model } = await resolveAiCredentials(USER, project);
  const provider = getProvider(providerName);
  let authInfo = null;
  try { authInfo = await loginLib.ensureAuthModule({ projectRoot: DIR, framework, provider, apiKey, model, loginContext: firstLoginCtx, credProfile, targetUrl, fs, path }); } catch (_) {}

  const specPaths = [];
  for (const r of picks) {
    const tc = r.testCase;
    const trail = reconstructTrail(r.richTraceFile);
    const actionPlan = buildActionPlan({ trail, status: r.status, stepResults: safeParse(r.stepResults) });
    try { const { actions, manifest } = locatorsLib.buildManifest({ actions: actionPlan.actions, kbRows, labelOf: (a) => elementLabelFromArgs(a.tool, a.args || {}), lang: 'ts' }); actionPlan.actions = actions; actionPlan.locatorManifest = manifest; } catch (_) {}
    let code = await codegen.generate({ framework, provider, apiKey, model, scenario: tc.scenario, testCase: tc, actionPlan, targetUrl, knownPopups: [], credProfile, authInfo });
    try { code = require('../server/services/codegen/_sanitize').sanitizeGenerated(code); } catch (_) {}
    const lay = codegen.layoutFor(framework, tc.scenario, tc);
    const split = require('../server/services/codegen/pom').splitFiles(code, lay);
    for (const [rel, content] of Object.entries(split)) { if (!content) continue; const full = path.join(DIR, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content, 'utf8'); }
    specPaths.push(lay.testFile);
    process.stdout.write(`  ✓ generated ${path.basename(lay.testFile)}\n`);
  }

  if (!RUN) { console.log('\nDRY (generation only). Add --run to execute.'); await prisma.$disconnect(); return; }
  console.log(`\n▶ Running ${specPaths.length} specs serially …\n`);
  try {
    const out = cp.execSync(`npx playwright test ${specPaths.map((p) => `"${p}"`).join(' ')} --reporter=line --workers=1`, { cwd: DIR, stdio: 'pipe', shell: true, timeout: 540000 });
    console.log(out.toString());
  } catch (e) { console.log((e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '')); }
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message, e.stack); prisma.$disconnect(); process.exit(1); });
