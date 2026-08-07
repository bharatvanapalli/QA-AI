'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'benchmarks', 'orangehrm');
const DEFAULT_REPORT = path.join(ROOT, 'benchmark_artifacts', 'scenario-benchmark-report.json');

const comparator = require(path.join(ROOT, 'server', 'services', 'reliability', 'benchmarkComparator'));

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function unique(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

function fixtureFiles() {
  return [
    'admin-search.expected.json',
    'claim-validation.expected.json',
    'data-binding.expected.json',
    'multi-row.expected.json',
    'execution-readiness.expected.json',
  ].map((name) => path.join(FIXTURE_DIR, name));
}

function negativeRegressionFixture() {
  return readJson(path.join(FIXTURE_DIR, 'negative-regressions.expected.json'));
}

function normalizeSuite(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.scenarios)) return input.scenarios;
  if (input.generation && Array.isArray(input.generation.scenarios)) return input.generation.scenarios;
  return [];
}

function caseCoverageRefs(tc, coveragePlanner) {
  const ops = safeJson(tc.operationsJson, null);
  const direct = []
    .concat(Array.isArray(tc.coverageRefs) ? tc.coverageRefs : [])
    .concat(ops && Array.isArray(ops.coverageRefs) ? ops.coverageRefs : []);
  if (direct.length) return direct.filter(Boolean);
  try {
    return coveragePlanner.caseCoverageRefs({ ...tc, operations: ops }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function scenarioFromDbRow(row, coveragePlanner) {
  return {
    id: row.id,
    name: row.name,
    module: row.module,
    priority: row.priority,
    category: row.category,
    rationale: row.rationale,
    cases: (row.cases || []).map((tc) => {
      const qualityContract = safeJson(tc.qualityContractJson, {}) || {};
      const phase45 = qualityContract.phase45 && typeof qualityContract.phase45 === 'object'
        ? qualityContract.phase45
        : {};
      const dataBinding = safeJson(tc.dataBindingJson, null);
      return {
        id: tc.id,
        name: tc.name,
        module: tc.module || row.module,
        type: tc.type,
        caseIntent: tc.caseIntent || tc.name,
        coverageRefs: unique([
          ...caseCoverageRefs(tc, coveragePlanner),
          ...(Array.isArray(phase45.coverageRefs) ? phase45.coverageRefs : []),
        ]),
        requirementRefs: safeJson(tc.requirementRefs, []),
        steps: safeJson(tc.steps, []),
        declaredAssertions: safeJson(tc.declaredAssertions, []),
        dataBinding,
        rowExecutionPlan: phase45.rowExecutionPlan || (dataBinding && dataBinding.rowExecutionPlan) || null,
        dataLineage: phase45.dataLineage || [],
        oracles: phase45.structuredOracles || phase45.oracles || [],
        browserActionBindings: phase45.browserActionBindings || [],
        qualityContract,
      };
    }),
  };
}

async function loadSuiteFromDb({ projectId, generationId }) {
  let PrismaClient;
  try {
    require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') });
    ({ PrismaClient } = require(path.join(ROOT, 'node_modules', '@prisma', 'client')));
  } catch (err) {
    return { skipped: true, reason: `DB/client unavailable: ${err.message.split('\n')[0]}`, scenarios: [] };
  }
  const prisma = new PrismaClient();
  const coveragePlanner = require(path.join(ROOT, 'server', 'services', 'coveragePlanner'));
  try {
    let generation = null;
    if (generationId) {
      generation = await prisma.scenarioGeneration.findUnique({ where: { id: generationId } });
    } else if (projectId) {
      generation = await prisma.scenarioGeneration.findFirst({
        where: { projectId, isCurrent: true },
        orderBy: { version: 'desc' },
      });
    } else {
      generation = await prisma.scenarioGeneration.findFirst({
        where: { isCurrent: true },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (!generation) return { skipped: true, reason: 'No ScenarioGeneration found.', scenarios: [] };
    const scenarios = await prisma.testScenario.findMany({
      where: { generationId: generation.id },
      include: { cases: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      generation: {
        id: generation.id,
        projectId: generation.projectId,
        version: generation.version,
        isCurrent: generation.isCurrent,
        createdAt: generation.createdAt,
      },
      coverageManifest: safeJson(generation.coveragePlanJson, null),
      scenarios: scenarios.map((row) => scenarioFromDbRow(row, coveragePlanner)),
    };
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

function loadSuiteFromFile(filePath) {
  const payload = readJson(filePath);
  return {
    sourceFile: filePath,
    scenarios: normalizeSuite(payload),
    generation: payload.generation || null,
  };
}

function syntheticRegressionScenarios(id) {
  if (id === 'double-encoded-steps') {
    return [{
      cases: [{
        id,
        steps: JSON.stringify(JSON.stringify([{ action: 'Click', target: 'Save button' }])),
      }],
    }];
  }
  if (id === 'generic-weak-oracle') {
    return [{
      cases: [{
        id,
        steps: [{ action: 'Click', target: 'Save button', expected: 'page ready' }],
      }],
    }];
  }
  if (id === 'verify-kind-none') {
    return [{
      cases: [{
        id,
        steps: [{ action: 'Verify', target: 'Result row', verify: { kind: 'none' }, expected: 'as expected' }],
      }],
    }];
  }
  if (id === 'login-business-token-collision') {
    return [{
      cases: [{
        id,
        name: 'Admin Search',
        steps: [{ action: 'Fill', target: 'Username search field', value: '{{loginusername}}' }],
      }],
    }];
  }
  if (id === 'missing-row-execution-plan') {
    return [{
      cases: [{
        id,
        dataBinding: { sheet: 'PIM_EmployeeLifecycle' },
        steps: [
          { action: 'Fill', target: 'Employee Id field', value: '{{employeeid}}' },
          { action: 'Verify', target: 'Personal Details', verify: { kind: 'text', text: 'Personal Details' } },
        ],
      }],
    }];
  }
  return [];
}

function runBenchmarks(suite) {
  const results = fixtureFiles().map((filePath) => {
    const expected = readJson(filePath);
    const result = comparator.compareScenarioBenchmark({
      scenarios: suite.scenarios,
      expected,
      context: {
        coverageManifest: suite.coverageManifest || null,
      },
    });
    return {
      fixture: path.basename(filePath),
      benchmarkId: result.benchmarkId,
      pass: result.ok,
      missingCoverageRefs: result.failures.filter((f) => f.code === 'benchmark_missing_coverage_ref'),
      missingRequiredFields: result.failures.filter((f) => f.code === 'benchmark_missing_required_field'),
      missingOracles: result.failures.filter((f) => f.code === 'benchmark_missing_required_oracle'),
      missingRowIntents: result.failures.filter((f) => f.code === 'benchmark_missing_row_intent'),
      contractDefects: result.failures.filter((f) => f.code === 'benchmark_contract_defect'),
      failures: result.failures,
    };
  });
  const regressionSpec = negativeRegressionFixture();
  const regressionFixtures = (regressionSpec.regressions || []).map((regression) => ({
    ...regression,
    scenarios: syntheticRegressionScenarios(regression.id),
  }));
  const regressionResult = comparator.compareNegativeRegressions({ fixtures: regressionFixtures });
  return {
    benchmarkId: 'orangehrm-scenario-generation',
    pass: results.every((result) => result.pass) && regressionResult.ok,
    fixturesLoaded: fixtureFiles().map((filePath) => path.basename(filePath)).concat(['negative-regressions.expected.json']),
    results,
    regressionDetectionResults: regressionResult.results,
  };
}

async function main() {
  const scenarioPath = argValue('--scenarios') || process.env.QAAI_BENCHMARK_SCENARIOS;
  const reportPath = argValue('--report') || process.env.QAAI_BENCHMARK_REPORT || DEFAULT_REPORT;
  const generationId = argValue('--generationId') || process.env.QAAI_BENCHMARK_GENERATION_ID || null;
  const projectId = argValue('--projectId') || process.env.QAAI_BENCHMARK_PROJECT_ID || null;
  const allowSkip = hasFlag('--allow-skip') || process.env.QAAI_BENCHMARK_ALLOW_SKIP === '1';

  const suite = scenarioPath
    ? loadSuiteFromFile(path.resolve(scenarioPath))
    : await loadSuiteFromDb({ projectId, generationId });

  const benchmark = runBenchmarks(suite);
  const report = {
    schemaVersion: 'qaai.reliability.benchmark.report.v1',
    generatedAt: new Date().toISOString(),
    source: scenarioPath ? 'scenario_json' : 'database_generation',
    sourceFile: suite.sourceFile || null,
    generation: suite.generation || null,
    skipped: !!suite.skipped,
    skipReason: suite.reason || null,
    scenarioCount: (suite.scenarios || []).length,
    caseCount: (suite.scenarios || []).reduce((sum, scenario) => sum + ((scenario.cases || []).length), 0),
    benchmarkId: benchmark.benchmarkId,
    pass: !suite.skipped && benchmark.pass,
    missingCoverageRefs: benchmark.results.flatMap((result) => result.missingCoverageRefs),
    missingRequiredFields: benchmark.results.flatMap((result) => result.missingRequiredFields),
    missingOracles: benchmark.results.flatMap((result) => result.missingOracles),
    missingRowIntents: benchmark.results.flatMap((result) => result.missingRowIntents),
    contractDefects: benchmark.results.flatMap((result) => result.contractDefects),
    regressionDetectionResults: benchmark.regressionDetectionResults,
    fixtureResults: benchmark.results,
    fixturesLoaded: benchmark.fixturesLoaded,
  };
  writeJson(reportPath, report);
  console.log(`Benchmark report: ${reportPath}`);
  console.log(`Scenarios: ${report.scenarioCount}, cases: ${report.caseCount}`);
  console.log(`Result: ${report.pass ? 'PASS' : (report.skipped ? 'SKIPPED' : 'FAIL')}`);
  if (report.skipped) console.log(`Skip reason: ${report.skipReason}`);
  if (report.missingCoverageRefs.length) console.log(`Missing coverageRefs: ${report.missingCoverageRefs.length}`);
  if (report.missingRequiredFields.length) console.log(`Missing required fields: ${report.missingRequiredFields.length}`);
  if (report.missingOracles.length) console.log(`Missing oracles: ${report.missingOracles.length}`);
  if (report.missingRowIntents.length) console.log(`Missing row intents: ${report.missingRowIntents.length}`);
  if (report.contractDefects.length) console.log(`Contract defects: ${report.contractDefects.length}`);
  if (report.skipped && allowSkip) process.exit(0);
  process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
