#!/usr/bin/env node
'use strict';

/**
 * Regression guard for user-directed generation guidance.
 *
 * This is intentionally source-level and deterministic: the feature touches
 * Prisma, API routes, Architect prompts, case refinement, and two UI surfaces.
 * The guard prevents future edits from leaving one layer wired while another
 * quietly ignores the user's guidance.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let failures = 0;

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  OK ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

function contains(file, needle) {
  return read(file).includes(needle);
}

function matches(file, pattern) {
  return pattern.test(read(file));
}

console.log('\n[1] Persistence contract');
check('Prisma has GenerationGuidance model', contains('prisma/schema.prisma', 'model GenerationGuidance'));
check('Project relation exposes generationGuidance', contains('prisma/schema.prisma', 'generationGuidance GenerationGuidance[]'));
check('Migration creates GenerationGuidance table', contains('prisma/migrations/20260621000000_add_generation_guidance/migration.sql', 'CREATE TABLE "GenerationGuidance"'));
check('Migration indexes project/scope/status', contains('prisma/migrations/20260621000000_add_generation_guidance/migration.sql', 'GenerationGuidance_projectId_scope_status_idx'));

console.log('\n[2] API contract');
check('Guidance route is mounted under projects', contains('server/index.js', "app.use('/api/projects/:projectId/generation-guidance', generationGuidanceRoutes);"));
check('Guidance route creates saved instructions', matches('server/routes/generationGuidance.js', /router\.post\(\s*'\/'\s*,[\s\S]*createGuidance/));
check('Guidance route can reject stale guidance', contains('server/routes/generationGuidance.js', "router.post('/:id/reject'"));
check('Guidance service builds normalized prompt block', contains('server/services/generationGuidance.js', 'function guidancePromptBlock'));
check('Guidance prompt preserves deterministic contracts', contains('server/services/generationGuidance.js', 'requirement traceability, data binding, assertion fidelity, and runnable steps'));

console.log('\n[3] Generation wiring');
check('Scenario generation accepts guidanceId', matches('server/routes/scenarios.js', /const\s*\{\s*requirementIds[\s\S]*guidanceId/));
check('Scenario generation injects guidance prompt', contains('server/routes/scenarios.js', 'guidancePromptBlock'));
check('Scenario generation marks guidance applied', contains('server/routes/scenarios.js', 'appliedGenerationId'));
check('Scenario regeneration accepts guidanceId', matches('server/routes/scenarios.js', /router\.post\(\s*'\/:id\/regenerate'[\s\S]*guidanceId/));
check('Scenario regeneration marks scenario-level application', contains('server/routes/scenarios.js', 'appliedScenarioId'));

console.log('\n[4] Case refinement wiring');
check('Case refine route exists', contains('server/routes/testCases.js', "'/:tcId/refine'"));
check('Case refine calls Architect normaliser', contains('server/routes/testCases.js', 'architect.normaliseCase'));
check('Case refine rebuilds declared assertions', contains('server/routes/testCases.js', 'declaredAssertionsLib.normalizeForCase'));
check('Case refine returns case to pending review', contains('server/routes/testCases.js', "status: 'pending'"));
check('Case refine marks guidance applied to test case', contains('server/routes/testCases.js', 'appliedTestCaseId'));

console.log('\n[5] UI contract');
check('Reusable guidance panel exists', contains('src/components/GenerationGuidancePanel.jsx', 'export default function GenerationGuidancePanel'));
check('Run Suite saves generation guidance', contains('src/pages/RunSuite.jsx', '/generation-guidance'));
check('Run Suite passes guidanceId into generation', contains('src/pages/RunSuite.jsx', 'guidanceId: suiteGuidance.id'));
check('Run Suite exposes Generation brief action', contains('src/pages/RunSuite.jsx', 'Generation brief'));
check('Test Cases exposes Refine with AI', contains('src/pages/TestCases.jsx', 'Refine with AI'));
check('Test Cases exposes per-case Improve action', contains('src/pages/TestCases.jsx', 'Improve'));
check('Test Cases calls case refine endpoint', contains('src/pages/TestCases.jsx', '/refine'));
check('Test Cases passes guidanceId into scenario generation', contains('src/pages/TestCases.jsx', 'body.guidanceId = options.guidanceId'));

if (failures) {
  console.error(`\nverify_generation_guidance failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log('\nverify_generation_guidance passed.');
