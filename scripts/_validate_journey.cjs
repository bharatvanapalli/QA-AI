'use strict';
/**
 * Validate the P1 journey export END-TO-END on real data (spends a few credits):
 *  1. Pick two real traced cases from a run that form a Create → Search/View
 *     sequence (a dependency journey).
 *  2. Reconstruct each from its persisted gz trace (the completion-pass path).
 *  3. Replay locators (P2), author ONE flat journey spec (generateJourney).
 *  4. Write it into an already-installed Playwright project and RUN it.
 *
 *   node scripts/_validate_journey.cjs            # DRY: generate + print, no test run
 *   node scripts/_validate_journey.cjs --run      # also `npx playwright test` the journey spec
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
const RUN_PREFIX = 'ae36bfe8';
const RUN_TEST = process.argv.includes('--run');
const INSTALLED_DIR = path.join(__dirname, '..', 'playwright', 'refit', 'ae36bfe8-97f5-4252-b42f-551971423b08');

const safeParse = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : (s || null); } catch (_) { return null; } };

(async () => {
  const project = await prisma.project.findUnique({ where: { id: PROJECT }, select: { name: true, framework: true, targetUrl: true, testCredentials: true } });
  const framework = (project.framework && codegen.supportsJourney(project.framework)) ? project.framework : 'playwright-pom';
  const targetUrl = project.targetUrl;
  const run = await prisma.run.findFirst({ where: { projectId: PROJECT, id: { startsWith: RUN_PREFIX } }, select: { id: true } });

  const rrs = await prisma.runResult.findMany({
    where: { runId: run.id, richTraceFile: { not: null } },
    select: { status: true, richTraceFile: true, stepResults: true,
      testCase: { select: { id: true, name: true, type: true, steps: true, declaredAssertions: true,
        scenario: { select: { name: true, module: true, category: true } } } } },
  });

  // Pick a Create case + a List/Search case, both with non-empty traces.
  const traced = rrs.filter((r) => reconstructTrail(r.richTraceFile).length > 0 && r.testCase);
  const producer = traced.find((r) => /add .*employee|add a new employee/i.test(r.testCase.name)) || traced[0];
  const consumer = traced.find((r) => r !== producer && /employee list|search|filter|view/i.test(r.testCase.name)) || traced.find((r) => r !== producer);
  if (!producer || !consumer) { console.log('Could not find two traced cases to form a journey.'); await prisma.$disconnect(); return; }

  console.log(`Project: ${project.name} · framework: ${framework}`);
  console.log(`Journey from run ${run.id.slice(0, 8)}:`);
  console.log(`  STEP 1 (${producer.status}): ${producer.testCase.name}`);
  console.log(`  STEP 2 (${consumer.status}): ${consumer.testCase.name}\n`);

  // KB locators for replay.
  const kbRows = await prisma.knowledgeBaseLocator.findMany({ where: { projectId: PROJECT },
    select: { element: true, role: true, accessibleName: true, selector: true, strategy: true, healthScore: true, occurrences: true, pageUrl: true } });

  const mk = (r) => {
    const trail = reconstructTrail(r.richTraceFile);
    const actionPlan = buildActionPlan({ trail, status: r.status, stepResults: safeParse(r.stepResults) });
    const { actions, manifest } = locatorsLib.buildManifest({ actions: actionPlan.actions, kbRows, labelOf: (a) => elementLabelFromArgs(a.tool, a.args || {}), lang: 'ts' });
    actionPlan.actions = actions; actionPlan.locatorManifest = manifest;
    return { testCase: r.testCase, actionPlan };
  };
  const journeyCases = [mk(producer), mk(consumer)];
  const scenario = producer.testCase.scenario || { name: 'PIM journey', module: 'PIM' };

  // Credentials + shared login from the trail (Admin/admin123).
  let firstLoginCtx = null;
  for (const r of [producer, consumer]) {
    const t = reconstructTrail(r.richTraceFile);
    const ctx = loginLib.extractLoginContext({ actions: t.map((a) => ({ tool: a.tool, args: a.args })) }, targetUrl);
    if (ctx.observed && ctx.observed.username) { firstLoginCtx = ctx; break; }
  }
  const credProfile = envContract.buildCredentialProfile({ testCredentials: project.testCredentials, observed: firstLoginCtx ? firstLoginCtx.observed : null });
  console.log(`Credentials: ${credProfile.hasCreds ? credProfile.users[0].username : 'NONE'}  ·  login path ${firstLoginCtx?.loginPath || '?'}\n`);

  const { provider: providerName, apiKey, model } = await resolveAiCredentials(USER, project);
  if (!apiKey) { console.log('No API key for USER — aborting.'); await prisma.$disconnect(); return; }
  const provider = getProvider(providerName);

  // Auth module already exists in the installed dir (idempotent) — ensure anyway.
  let authInfo = null;
  try { authInfo = await loginLib.ensureAuthModule({ projectRoot: INSTALLED_DIR, framework, provider, apiKey, model, loginContext: firstLoginCtx, credProfile, targetUrl, fs, path }); } catch (e) { console.log('auth ensure warn:', e.message); }

  console.log(`Generating journey spec via ${providerName}/${model} …`);
  let content = await codegen.generateJourney({ framework, provider, apiKey, model, scenario, journeyCases, targetUrl, credProfile, authInfo });
  try { content = require('../server/services/codegen/_sanitize').sanitizeGenerated(content); } catch (_) {}
  const lay = codegen.layoutForJourney(framework, scenario, journeyCases.map((c) => c.testCase));
  const full = path.join(INSTALLED_DIR, lay.testFile);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  console.log(`\nWrote ${lay.testFile} (${content.split('\n').length} lines). Preview:\n`);
  console.log(content.split('\n').slice(0, 60).map((l) => '  | ' + l).join('\n'));

  if (!RUN_TEST) { console.log('\nDRY (codegen only). Re-run with --run to execute the journey spec.'); await prisma.$disconnect(); return; }

  console.log(`\n▶ npx playwright test ${lay.testFile} …\n`);
  try {
    const out = cp.execSync(`npx playwright test "${lay.testFile}" --reporter=line`, { cwd: INSTALLED_DIR, stdio: 'pipe', shell: true, timeout: 180000 });
    console.log(out.toString());
    console.log('\n✅ JOURNEY SPEC PASSED — exported verdict == MCP verdict (both steps green in one test).');
  } catch (e) {
    console.log((e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : ''));
    console.log('\n❌ Journey spec did not pass — inspect output above.');
  }
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message, e.stack); prisma.$disconnect(); process.exit(1); });
