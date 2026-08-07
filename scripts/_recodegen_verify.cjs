'use strict';
/**
 * Re-run CODEGEN ONLY (no browser, no architect) for an existing run, using the
 * stored richTrace as the action plan and the FIXED generator (shared credential
 * contract + shared login + per-case page objects + verdict fidelity). Proves
 * the fix on real output and repairs the existing exported suite.
 *
 *   node scripts/_recodegen_verify.cjs            # DRY: reconstruct + report, NO LLM, NO write
 *   node scripts/_recodegen_verify.cjs --go       # spends credits: real re-codegen into playwright/refit/<runId>
 *
 * Never touches the canonical playwright/runs/<runId> dir (the UI fixture).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const codegen = require('../server/services/codegen');
const envContract = require('../server/services/codegen/_env');
const loginLib = require('../server/services/codegen/_login');
const { reconstructTrail, buildActionPlan } = require('../server/services/codegen/_replayTrace');
const { resolveAiCredentials } = require('../server/lib/resolveAiCredentials');
const { getProvider } = require('../server/lib/llmProvider');

const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const USER = 'a5d916cd-4178-4bcc-b409-c885a389e843';
const GO = process.argv.includes('--go');
const RUN_ARG = (process.argv.find((a) => a.startsWith('--run=')) || '').split('=')[1] || null;

// reconstructTrail + buildActionPlan now live in server/services/codegen/_replayTrace.js
// (the SAME path the live journey-emission pass uses — DRY, single source of truth).

function parseMaybe(s, dflt) { try { return typeof s === 'string' ? JSON.parse(s) : (s || dflt); } catch (_) { return dflt; } }

(async () => {
  const project = await prisma.project.findUnique({ where: { id: PROJECT }, select: { name: true, framework: true, targetUrl: true, testCredentials: true } });
  const run = RUN_ARG
    ? await prisma.run.findFirst({ where: { projectId: PROJECT, id: { startsWith: RUN_ARG } }, select: { id: true } })
    : await prisma.run.findFirst({ where: { projectId: PROJECT }, orderBy: { startedAt: 'desc' }, select: { id: true } });
  const rrs = await prisma.runResult.findMany({
    where: { runId: run.id },
    select: {
      status: true, richTraceFile: true, stepResults: true,
      testCase: { select: { id: true, name: true, type: true, steps: true, assertions: true, declaredAssertions: true,
        scenario: { select: { name: true, module: true, category: true, priority: true, rationale: true } } } },
    },
  });
  const framework = project.framework || 'playwright-pom';
  const targetUrl = project.targetUrl;
  console.log(`Project: ${project.name} · framework: ${framework}`);
  console.log(`Run ${run.id.slice(0, 8)} · ${rrs.length} results · mode: ${GO ? 'GO (will spend credits + write)' : 'DRY'}`);

  // Build a credential profile + login context from the first case that logged in.
  let credProfile = envContract.buildCredentialProfile({ testCredentials: project.testCredentials });
  let firstLoginCtx = null;
  for (const rr of rrs) {
    const trail = reconstructTrail(rr.richTraceFile);
    const ap = { actions: trail.map((a) => ({ tool: a.tool, args: a.args })) };
    const ctx = loginLib.extractLoginContext(ap, targetUrl);
    if (ctx.observed.username) { firstLoginCtx = ctx; break; }
  }
  if (!credProfile.hasCreds && firstLoginCtx) {
    credProfile = envContract.buildCredentialProfile({ testCredentials: project.testCredentials, observed: firstLoginCtx.observed });
  }
  console.log(`Credentials: ${credProfile.hasCreds ? credProfile.users[0].username + ' / ' + (credProfile.users[0].password ? '••••' : '(none)') : 'NONE'}  (env: QAAI_USERNAME/QAAI_PASSWORD)`);
  console.log(`Login: path ${firstLoginCtx?.loginPath || '?'} → post ${firstLoginCtx?.postLoginUrlHint || '?'}`);

  if (!GO) {
    // DRY: show one reconstructed action plan and exit (no LLM, no write).
    const sample = rrs.find((r) => r.richTraceFile);
    const trail = reconstructTrail(sample.richTraceFile);
    console.log(`\nDRY sample — "${sample.testCase.name}" (${sample.status}) · ${trail.length} actions`);
    for (const a of trail.slice(0, 10)) console.log('   ', JSON.stringify({ tool: a.tool, args: a.args }).slice(0, 150));
    const decl = parseMaybe(sample.testCase.declaredAssertions, []);
    console.log(`   declaredAssertions: ${decl.length}`);
    console.log('\nDRY OK. Re-run with --go to spend credits and write the repaired suite to playwright/refit/' + run.id.slice(0, 8));
    await prisma.$disconnect(); return;
  }

  // GO: resolve provider + re-codegen each case into a scratch dir.
  const { provider: providerName, apiKey, model } = await resolveAiCredentials(USER, project);
  if (!apiKey) { console.log('No API key resolved for user ' + USER + ' — aborting (set the correct USER).'); await prisma.$disconnect(); return; }
  const provider = getProvider(providerName);
  console.log(`Provider: ${providerName} · model: ${model}\n`);

  const refit = path.join(__dirname, '..', 'playwright', 'refit', String(run.id));
  fs.rmSync(refit, { recursive: true, force: true });
  fs.mkdirSync(refit, { recursive: true });

  let authInfo = null;
  let done = 0, failed = 0;
  for (const rr of rrs) {
    const tc = rr.testCase;
    if (!tc) { continue; }
    const scenario = tc.scenario || { name: tc.name, module: 'app' };
    const trail = reconstructTrail(rr.richTraceFile);
    const actionPlan = buildActionPlan({ trail, status: rr.status, stepResults: parseMaybe(rr.stepResults, null) });
    try {
      // shells + shared login authored once (idempotent)
      if (framework === 'playwright-pom' || framework === 'playwright-flat') require('../server/services/codegen/pom').ensureProjectShell(refit, { targetUrl, credProfile });
      else if (framework === 'playwright-js') require('../server/services/codegen/playwrightJs').ensureProjectShell(refit, { targetUrl, credProfile });
      else { const m = { 'selenium-java': 'selenium', 'selenium-bdd': 'seleniumBdd', 'playwright-bdd': 'playwrightBdd', 'cucumber-playwright': 'playwrightBdd' }[framework]; if (m) require('../server/services/codegen/' + m).ensureProjectShell(refit, { targetUrl, credProfile }); }
      if (!authInfo) {
        const ctx = firstLoginCtx || loginLib.extractLoginContext(actionPlan, targetUrl);
        authInfo = await loginLib.ensureAuthModule({ projectRoot: refit, framework, provider, apiKey, model, loginContext: ctx, credProfile, targetUrl, fs, path });
      }
      let code = await codegen.generate({ framework, provider, apiKey, model, scenario, testCase: tc, actionPlan, targetUrl, knownPopups: [], credProfile, authInfo });
      try { code = require('../server/services/codegen/_sanitize').sanitizeGenerated(code); } catch (_) {}
      const lay = codegen.layoutFor(framework, scenario, tc);
      const split = require('../server/services/codegen/' + ({ 'playwright-pom': 'pom', 'playwright-flat': 'pom', 'playwright-js': 'playwrightJs', 'selenium-java': 'selenium', 'selenium-bdd': 'seleniumBdd', 'playwright-bdd': 'playwrightBdd', 'cucumber-playwright': 'playwrightBdd' }[framework] || 'pom')).splitFiles(code, lay);
      for (const [rel, content] of Object.entries(split)) {
        if (!content) continue;
        const full = path.join(refit, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
      }
      done++;
      process.stdout.write(`  ✓ ${tc.name.slice(0, 56)} (${rr.status})\n`);
    } catch (e) {
      failed++;
      process.stdout.write(`  ✗ ${tc.name.slice(0, 56)} — ${String(e.message).slice(0, 120)}\n`);
    }
  }
  console.log(`\nGenerated ${done} case(s), ${failed} failed. Output: ${refit}`);
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message, e.stack); prisma.$disconnect(); process.exit(1); });
