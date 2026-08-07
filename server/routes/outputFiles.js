'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const prisma = require('../prisma');
const audit = require('../services/audit');
const { resolveAiCredentials } = require('../lib/resolveAiCredentials');
const { getProvider } = require('../lib/llmProvider');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');
const { clearProjectFiles } = require('../services/outputFilesCleanup');
const { ZipWriter } = require('../lib/zipWriter');
const { openInVsCode, pathIsSafe } = require('../lib/vscodeLauncher');
const replayExport = require('../services/codegen/replayExport');
const liveReplayCodegen = require('../services/codegen/liveReplayCodegen');
const enterpriseMode = require('../services/enterpriseMode');
const evidenceBundle = require('../services/evidenceBundle');
const scriptValidationRunner = require('../services/scriptValidationRunner');
const outputReadiness = require('../services/outputReadiness');
const scriptValidationAgent = require('../services/scriptValidationAgent');
const scriptBundleStore = require('../services/scriptBundleStore');
const scriptRepairAgent = require('../services/scriptRepairAgent');
const { decodeJson } = require('../services/jsonField');
const { normalizeInteractiveControlName } = require('../services/outputLocatorFallback');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

// ── Certification summary ─────────────────────────────────
// Aggregates exportMeta states from all RunResults for a given run.
// Returns { headline, pipelineRan, total, certified, draft,
//           incomplete_evidence, not_exportable, repairing, withoutPipeline, lastCertifiedAt }
// or null if the run has no results at all.
async function computeCertSummary(runId) {
  if (!runId || runId === LEGACY_RUN_ID) return null;
  try {
    const rows = await prisma.runResult.findMany({
      where: { runId },
      select: { id: true, exportMeta: true },
    });
    if (!rows.length) return null;
    const counts = {};
    const issues = [];
    let lastCertifiedAt = null;
    for (const row of rows) {
      if (!row.exportMeta) { counts.no_pipeline = (counts.no_pipeline || 0) + 1; continue; }
      let meta;
      try { meta = JSON.parse(row.exportMeta); } catch (_) { counts.no_pipeline = (counts.no_pipeline || 0) + 1; continue; }
      const state = meta.state || 'no_pipeline';
      counts[state] = (counts[state] || 0) + 1;
      if (state === 'certified' && meta.certifiedAt && (!lastCertifiedAt || meta.certifiedAt > lastCertifiedAt)) {
        lastCertifiedAt = meta.certifiedAt;
      }
      for (const failure of Array.isArray(meta.repairFailures) ? meta.repairFailures : []) {
        if (issues.length >= 8) break;
        issues.push({
          runResultId: row.id,
          rule: failure.reason || 'repair_failed',
          message: failure.reason === 'auth_required' || failure.reason === 'auth_precondition_required' || failure.reason === 'auth_still_required'
            ? 'Protected page recapture needs an authenticated session before locators can be recovered.'
            : `Output repair could not recapture evidence: ${failure.reason || 'repair_failed'}.`,
          path: failure.pageUrl || null,
          detail: failure.narration || null,
        });
      }
      if (meta.handoff && issues.length < 8) {
        issues.push({
          runResultId: row.id,
          rule: meta.handoff,
          message: meta.handoff === 'auth_precondition_required'
            ? 'Output repair reached a login wall. Configure/use a valid auth fixture or credentials for protected-page recapture.'
            : 'Output evidence still requires live reacquisition before this case can be exported.',
          path: null,
        });
      }
    }
    const total = rows.length;
    // Headline priority: worst first
    const PRIORITY = ['repairing', 'not_exportable', 'incomplete_evidence', 'draft', 'certified'];
    let headline = null;
    for (const s of PRIORITY) {
      if (counts[s] > 0) { headline = s; break; }
    }
    const pipelineRan = PRIORITY.some((s) => counts[s] > 0);
    return {
      headline,
      pipelineRan,
      total,
      certified: counts.certified || 0,
      draft: counts.draft || 0,
      incomplete_evidence: counts.incomplete_evidence || 0,
      not_exportable: counts.not_exportable || 0,
      repairing: counts.repairing || 0,
      withoutPipeline: counts.no_pipeline || 0,
      lastCertifiedAt,
      issues,
    };
  } catch (_) {
    return null;
  }
}

const PLAYWRIGHT_DIR = path.join(__dirname, '..', '..', 'playwright');
const RUNS_DIR = path.join(PLAYWRIGHT_DIR, 'runs');
const OUTPUT_ASSISTANT_GUIDE_DIR = path.join(__dirname, '..', 'prompts', 'output-files');
const OUTPUT_ASSISTANT_WRITER_GUIDE = path.join(OUTPUT_ASSISTANT_GUIDE_DIR, 'playwright-script-writer.md');
const OUTPUT_ASSISTANT_HEALER_GUIDE = path.join(OUTPUT_ASSISTANT_GUIDE_DIR, 'playwright-script-healer.md');

// Phase F.1 per-run isolation — each new run's POM + spec files land
// under playwright/runs/<runId>/. Anything emitted BEFORE this change
// lives at playwright/pages/ + playwright/tests/ — we surface that as
// a synthetic "Workspace" entry so legacy outputs aren't erased from view.
//
// Resolver contract: return ONE workspace to display.
//   - If ?runId is provided AND has files on disk, use it.
//   - Else, use the most recent run with output files.
//   - Else, fall back to the legacy workspace root (if it has files).
//   - Else, return null → empty state.
const LEGACY_RUN_ID = '__legacy__';
const REPLAYIR_SOURCE = 'replayir';
const LEGACY_SOURCE = 'legacy';
const DEFAULT_REPLAY_FRAMEWORK = 'playwright-reference';
const PROJECT_REPLAY_FRAMEWORKS = {
  'playwright-pom': 'playwright-pom',
  'playwright-flat': 'playwright-reference',
  'playwright-js': 'playwright-pom-js',
  'playwright-bdd': 'replayir-bdd',
  'cucumber-playwright': 'replayir-bdd',
  'selenium-java': 'selenium-pom',
  'selenium-bdd': 'selenium-bdd-reference',
};
const UNSUPPORTED_REPLAY_FRAMEWORKS = {
};

function dirHasAnyFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  // Light walk — just check pages/ or tests/ contain at least one file.
  for (const sub of ['pages', 'tests']) {
    const abs = path.join(dir, sub);
    if (!fs.existsSync(abs)) continue;
    const stack = [abs];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile()) return true;
        if (e.isDirectory()) stack.push(path.join(cur, e.name));
      }
    }
  }
  return false;
}

function legacyWorkspaceRow() {
  return {
    id: LEGACY_RUN_ID,
    sprintId: null,
    sprintName: 'Workspace (pre-isolation)',
    status: 'archived',
    startedAt: null,
    completedAt: null,
    passed: 0, failed: 0, blocked: 0, skipped: 0,
  };
}

function latestDate(...values) {
  let latest = null;
  for (const value of values) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    if (!latest || date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

function runWithActivityFields(run) {
  if (!run) return run;
  const latestResultAt = run.results?.[0]?.createdAt || null;
  const latestResult = run.results?.[0] || null;
  return {
    ...run,
    latestResultAt,
    lastActivityAt: latestDate(latestResultAt, run.completedAt, run.startedAt),
    outputEvidence: latestResult
      ? {
          replayIr: !!latestResult.replayIrJson,
          executionContract: !!latestResult.executionContractJson,
          actionGraph: !!latestResult.actionGraphJson,
          exportMeta: !!latestResult.exportMeta,
        }
      : {
          replayIr: false,
          executionContract: false,
          actionGraph: false,
          exportMeta: false,
        },
  };
}

const RUN_SELECTOR_SELECT = {
  id: true,
  sprintId: true,
  sprintName: true,
  status: true,
  startedAt: true,
  completedAt: true,
  passed: true,
  failed: true,
  blocked: true,
  skipped: true,
  needsHuman: true,
  results: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: {
      createdAt: true,
      replayIrJson: true,
      executionContractJson: true,
      actionGraphJson: true,
      exportMeta: true,
    },
  },
};

async function resolveTargetRun(req, project) {
  const requested = typeof req.query?.runId === 'string' && req.query.runId.trim()
    ? req.query.runId.trim()
    : null;
  const generationId = requested && requested !== LEGACY_RUN_ID
    ? null
    : await resolveRequestedGenerationId(req, project);

  // Explicit legacy request.
  if (requested === LEGACY_RUN_ID) {
    if (dirHasAnyFiles(PLAYWRIGHT_DIR)) {
      return { run: legacyWorkspaceRow(), runDir: PLAYWRIGHT_DIR };
    }
    // Fall through if the legacy workspace is also empty.
  }

  // Explicit per-run request.
  if (requested && requested !== LEGACY_RUN_ID) {
    const run = await prisma.run.findFirst({
      where: { id: requested, projectId: project.id },
      select: RUN_SELECTOR_SELECT,
    });
    if (run) {
      const dir = path.join(RUNS_DIR, run.id);
      return { run: runWithActivityFields(run), runDir: dir };
    }
  }

  // No explicit request — pick the most recent run that ACTUALLY has files
  // on disk. Don't pick an empty run just because it's the latest — that
  // was the bug that made the page look empty after a navigation.
  const recentRuns = await prisma.run.findMany({
    where: { projectId: project.id, ...(generationId ? { generationId } : {}) },
    orderBy: { startedAt: 'desc' },
    select: RUN_SELECTOR_SELECT,
    take: 20,
  });
  const recentRunsByActivity = recentRuns
    .map(runWithActivityFields)
    .sort((a, b) => (b.lastActivityAt?.getTime?.() || 0) - (a.lastActivityAt?.getTime?.() || 0));
  for (const r of recentRunsByActivity) {
    const dir = path.join(RUNS_DIR, r.id);
    if (dirHasAnyFiles(dir)) return { run: r, runDir: dir };
  }

  // No per-run dir has files. Fall back to the legacy workspace root.
  if (dirHasAnyFiles(PLAYWRIGHT_DIR)) {
    return { run: legacyWorkspaceRow(), runDir: PLAYWRIGHT_DIR };
  }

  return { run: null, runDir: null };
}

// Directories we surface in the workspace tree. Order here is the order
// the UI gets — pages first (the POM heart), then tests, then shared
// scaffolding. Anything outside this list is hidden (we don't expose
// node_modules, test-results, .playwright caches etc.).
const TOP_LEVEL_DIRS = ['pages', 'locators', 'tests', 'fixtures', 'utils', 'step-definitions', 'steps', 'support', 'features', 'src', 'evidence'];
const TOP_LEVEL_FILES = [
  'playwright.config.ts',
  'playwright.config.js',
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'pom.xml',
  'testng.xml',
  '.env.example',
  '.gitignore',
  'README.md',
];

// Top-level dirs we EXPLICITLY hide. results/ + test-results/ are large
// run artifacts the user does not want to see in a "project source" view.
const HIDDEN_TOP = new Set(['results', 'test-results', 'node_modules', 'playwright-report']);
const DEFAULT_OUTPUT_REPAIR_MAX_ROUNDS = 5;

function outputRepairMaxRounds() {
  const raw = Number(process.env.QAAI_OUTPUT_REPAIR_MAX_ROUNDS || DEFAULT_OUTPUT_REPAIR_MAX_ROUNDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_OUTPUT_REPAIR_MAX_ROUNDS;
}

async function ownProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, orgId: req.org.id },
  });
}

// ── Tree shape walker ─────────────────────────────────────
//
// Returns a hierarchical { name, type, children?, sizeBytes?, mtime?, kind? }
// tree rooted at the project's playwright workspace. Files get a `kind`
// hint (spec | page | fixture | util | config | env | misc) so the UI can
// pick the right icon without re-parsing the path.
function walkTree(dir, relPath = '') {
  const stat = fs.statSync(dir);
  const name = path.basename(dir);
  if (!stat.isDirectory()) {
    return {
      name,
      path: relPath,
      type: 'file',
      sizeBytes: stat.size,
      mtime: stat.mtime,
      kind: classifyFile(relPath),
    };
  }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') || ['env.example', 'gitignore'].includes(e.name.slice(1)));
  const children = entries
    .map((e) => walkTree(path.join(dir, e.name), relPath ? `${relPath}/${e.name}` : e.name))
    .sort((a, b) => {
      // Directories first, then files, both alpha.
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  return { name, path: relPath, type: 'dir', children };
}

function classifyFile(relPath) {
  if (relPath.endsWith('.spec.ts') || relPath.endsWith('.spec.js')) return 'spec';
  if (relPath.endsWith('.feature')) return 'spec';
  if (relPath.endsWith('.steps.ts') || relPath.endsWith('.steps.js')) return 'spec';
  if (/\/data\/.+\.(?:xlsx|csv|json)$/i.test(relPath) || /^tests\/data\//i.test(relPath) || /^src\/test\/resources\/test-data\//i.test(relPath)) return 'data';
  if (relPath.startsWith('locators/')) return 'locator';
  if (relPath.startsWith('evidence/') || /^EXPORT_MANIFEST\.json$/i.test(relPath) || /^CERTIFICATION_REPORT\.json$/i.test(relPath)) return 'evidence';
  if (relPath.startsWith('step-definitions/') || relPath.startsWith('steps/')) return 'spec';
  if (relPath.includes('/steps/') && relPath.endsWith('.java')) return 'spec';
  // Selenium-Java / Maven layout.
  if (relPath.endsWith('Test.java') || relPath.includes('/tests/')) return 'spec';
  if (relPath.includes('/pages/') && relPath.endsWith('.java')) return 'page';
  if (relPath.includes('/base/') && relPath.endsWith('.java')) return 'fixture';
  if (relPath.endsWith('.java')) return 'misc';
  if (relPath.startsWith('pages/') && (relPath.endsWith('.ts') || relPath.endsWith('.js'))) return 'page';
  if (relPath.startsWith('fixtures/')) return 'fixture';
  if (relPath.startsWith('utils/')) return 'util';
  if (relPath.includes('.config.')) return 'config';
  if (relPath.startsWith('.env') || relPath.endsWith('.env.example')) return 'env';
  if (relPath === 'package.json' || relPath === 'tsconfig.json' || relPath === 'jsconfig.json') return 'config';
  if (relPath === 'pom.xml' || relPath === 'testng.xml') return 'config';
  if (relPath.endsWith('.md')) return 'doc';
  return 'misc';
}

// Aggregate counts on the tree, walked once.
function summariseTree(node, acc = { files: 0, dirs: 0, totalSize: 0, byKind: {} }) {
  if (node.type === 'file') {
    acc.files += 1;
    acc.totalSize += node.sizeBytes || 0;
    if (node.kind) acc.byKind[node.kind] = (acc.byKind[node.kind] || 0) + 1;
  } else {
    acc.dirs += 1;
    for (const c of node.children || []) summariseTree(c, acc);
  }
  return acc;
}

function wantsReplayIr(req) {
  const source = typeof req.query?.source === 'string' ? req.query.source.trim().toLowerCase() : '';
  return source === REPLAYIR_SOURCE;
}

function replayFramework(req, project) {
  const queryVal = typeof req.query?.framework === 'string' ? req.query.framework.trim() : '';
  const raw = queryVal || (project && project.framework) || '';
  // Block unsupported frameworks before any routing decision — both explicit query param and
  // project-level setting. Prevents a wrong-framework package from shipping silently.
  if (raw && Object.prototype.hasOwnProperty.call(UNSUPPORTED_REPLAY_FRAMEWORKS, raw)) {
    const err = new Error(UNSUPPORTED_REPLAY_FRAMEWORKS[raw]);
    err.status = 400;
    err.code = 'UNSUPPORTED_REPLAY_FRAMEWORK';
    err.framework = raw;
    throw err;
  }
  // Explicit query param may be either a project framework ("selenium-java") or
  // a direct ReplayIR adapter ID ("selenium-pom"). Normalize project names here
  // so API callers and the UI cannot accidentally ship the wrong framework.
  if (queryVal) return PROJECT_REPLAY_FRAMEWORKS[queryVal] || queryVal;
  // Project framework setting: single registry lookup; default to Playwright reference if absent.
  const f = project && project.framework;
  return (f && PROJECT_REPLAY_FRAMEWORKS[f]) || DEFAULT_REPLAY_FRAMEWORK;
}

function replayRunId(req) {
  const value = typeof req.query?.runId === 'string' ? req.query.runId.trim() : '';
  return value && value !== LEGACY_RUN_ID ? value : null;
}

async function resolveRequestedGenerationId(req, project) {
  const value = typeof req.query?.generationId === 'string' ? req.query.generationId.trim() : '';
  if (!value) return null;
  const generation = await prisma.scenarioGeneration.findFirst({
    where: { id: value, projectId: project.id },
    select: { id: true },
  });
  return generation?.id || null;
}

function replayRunResultIds(req) {
  const value = typeof req.query?.runResultIds === 'string' ? req.query.runResultIds.trim() : '';
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : null;
}

const PACKAGE_TREE_ORDER = new Map([
  ['package.json', 1],
  ['pom.xml', 1],
  ['playwright.config.ts', 2],
  ['playwright.config.js', 2],
  ['testng.xml', 2],
  ['tsconfig.json', 3],
  ['jsconfig.json', 3],
  ['README.md', 4],
  ['locators', 10],
  ['pages', 11],
  ['tests', 12],
  ['features', 13],
  ['steps', 14],
  ['step-definitions', 14],
  ['support', 15],
  ['fixtures', 16],
  ['utils', 17],
  ['src', 18],
  ['evidence', 19],
  ['.env.example', 90],
  ['.gitignore', 91],
  ['EXPORT_MANIFEST.json', 95],
  ['CERTIFICATION_REPORT.json', 96],
]);

function packageTreeRank(node) {
  const top = String(node && (node.path || node.name) || '').split('/')[0];
  return PACKAGE_TREE_ORDER.has(top) ? PACKAGE_TREE_ORDER.get(top) : 50;
}

function treeFromFiles(files, runId) {
  const root = { name: `replayir-${String(runId || 'run').slice(0, 8)}`, type: 'dir', path: '', children: [] };
  const dirs = new Map([['', root]]);
  const now = new Date();
  for (const [relRaw, content] of Object.entries(files || {})) {
    const rel = String(relRaw || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) continue;
    const parts = rel.split('/').filter(Boolean);
    let prefix = '';
    let parent = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      if (!dirs.has(prefix)) {
        const node = { name: parts[i], path: prefix, type: 'dir', children: [] };
        dirs.set(prefix, node);
        parent.children.push(node);
      }
      parent = dirs.get(prefix);
    }
    const name = parts[parts.length - 1];
    parent.children.push({
      name,
      path: rel,
      type: 'file',
      sizeBytes: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content || ''), 'utf8'),
      mtime: now,
      kind: classifyFile(rel),
    });
  }
  const sort = (node) => {
    if (!Array.isArray(node.children)) return node;
    node.children.sort((a, b) => {
      const rank = packageTreeRank(a) - packageTreeRank(b);
      if (rank !== 0) return rank;
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sort);
    return node;
  };
  return sort(root);
}

function bufferFromExportContent(content) {
  return Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8');
}

function parseJsonText(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function readDataRowsFromExport(files, relPath) {
  const content = files && files[relPath];
  if (typeof content !== 'string') return null;
  const parsed = parseJsonText(content, null);
  return Array.isArray(parsed) ? parsed : null;
}

function readWorkspaceJson(files, relPath, fallback = null) {
  const content = files && files[relPath];
  if (typeof content !== 'string') return fallback;
  const parsed = parseJsonText(content, fallback);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
}

function locatorAtlasFromWorkspace(workspace) {
  const report = readWorkspaceJson(workspace && workspace.files, 'evidence/locator-certification-report.json', null);
  if (!report || !Array.isArray(report.steps)) return null;
  return {
    schemaVersion: report.schemaVersion || null,
    evidenceSchemaVersion: report.evidenceSchemaVersion || null,
    caseId: report.caseId || null,
    title: report.title || null,
    summary: report.summary || null,
    steps: report.steps.slice(0, 200),
  };
}

function countGeneratedPlaywrightTests(files) {
  let count = 0;
  const dataFiles = Object.fromEntries(Object.entries(files || {}).filter(([rel]) => /^tests\/data\/.+\.json$/i.test(rel)));
  for (const [rel, content] of Object.entries(files || {})) {
    if (!/^tests\/.+\.spec\.(?:js|ts)$/i.test(rel)) continue;
    const text = String(content || '');
    const dataVars = new Map();
    let m;
    const loadRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*loadDataRows\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = loadRe.exec(text))) {
      const rows = readDataRowsFromExport({ ...dataFiles, ...files }, m[2]);
      dataVars.set(m[1], Array.isArray(rows) && rows.length ? rows.length : 1);
    }
    const loopRanges = [];
    const loopRe = /for\s*\(\s*const\s+row\s+of\s+([A-Za-z_$][\w$]*)\s*\)\s*\{[\s\S]*?\btest\s*\(/g;
    while ((m = loopRe.exec(text))) {
      count += dataVars.get(m[1]) || 1;
      loopRanges.push([m.index, loopRe.lastIndex]);
    }
    const stripped = loopRanges.reduceRight((acc, [start, end]) => acc.slice(0, start) + acc.slice(end), text);
    const journeySteps = (stripped.match(/\btest\.step\s*\(/g) || []).length;
    count += journeySteps || (stripped.match(/\btest\s*\(/g) || []).length;
  }
  return count;
}

function countGeneratedScriptFiles(files) {
  let count = 0;
  for (const rel of Object.keys(files || {})) {
    if (/^tests\/.+\.spec\.(?:js|ts)$/i.test(rel)) count += 1;
    else if (/^src\/test\/java\/.+Test\.java$/i.test(rel)) count += 1;
    else if (/^features\/.+\.feature$/i.test(rel)) count += 1;
  }
  return count;
}

function uniqueRunResultCount(manifestEntries = [], blocked = []) {
  const ids = new Set();
  for (const entry of manifestEntries || []) {
    for (const id of Array.isArray(entry && entry.runResultIds) ? entry.runResultIds : []) {
      if (id) ids.add(id);
    }
  }
  for (const item of blocked || []) {
    if (item && item.runResultId) ids.add(item.runResultId);
  }
  return ids.size;
}

function parseJsonFileContent(value) {
  try { return JSON.parse(String(value || '')); } catch (_) { return null; }
}

function scriptArtifactsFromManifest(manifest = {}, files = {}) {
  const direct = Array.isArray(manifest && manifest.artifacts)
    ? manifest.artifacts
    : (Array.isArray(manifest && manifest.scriptArtifacts) ? manifest.scriptArtifacts : []);
  if (direct.length) return direct;
  const liveStatus = parseJsonFileContent(files && files['evidence/live-output-status.json']);
  return Array.isArray(liveStatus && liveStatus.artifacts) ? liveStatus.artifacts : [];
}

function summarizeScriptArtifacts(manifest = {}, files = {}) {
  const artifacts = scriptArtifactsFromManifest(manifest, files);
  const counts = {
    total: artifacts.length,
    generated: 0,
    repairNeeded: 0,
    skeletonOnly: 0,
    certified: 0,
    failedSafety: 0,
    failedRun: 0,
  };
  for (const artifact of artifacts) {
    const generationStatus = String(artifact && artifact.scriptGenerationStatus || '');
    const runStatus = String(artifact && artifact.scriptRunStatus || '');
    const certStatus = String(artifact && artifact.certificationStatus || '');
    if (generationStatus === 'failed_safety') counts.failedSafety += 1;
    if (generationStatus === 'skeleton_only') counts.skeletonOnly += 1;
    if (generationStatus === 'generated' || generationStatus === 'generated_with_repairs_needed') counts.generated += 1;
    if (generationStatus === 'generated_with_repairs_needed' || generationStatus === 'skeleton_only') counts.repairNeeded += 1;
    if (runStatus === 'failed') counts.failedRun += 1;
    if (certStatus === 'certified') counts.certified += 1;
  }
  return { artifacts, counts };
}

function buildOutputPreparationSummary({ workspace, stats, certificationSummary, scriptValidation = null }) {
  const result = workspace && workspace.result || {};
  const files = workspace && workspace.files || {};
  const manifest = result.manifest || {};
  const artifactSummary = summarizeScriptArtifacts(manifest, files);
  const artifactCounts = artifactSummary.counts;
  const playwrightTestCount = countGeneratedPlaywrightTests(files);
  const generatedTests = playwrightTestCount || artifactCounts.generated || countGeneratedScriptFiles(files);
  const manifestTotal = Math.max(
    uniqueRunResultCount(manifest.entries || [], result.blocked || []),
    artifactCounts.total,
  );
  const runPayload = workspace && workspace.run ? serialiseRun(workspace.run) : null;
  const runSummary = runPayload ? runPayload.summary : {};
  const runStatus = workspace && workspace.run ? String(workspace.run.status || '') : '';
  const passedResults = Number(runSummary && runSummary.passed) || 0;
  const executableResults = passedResults || manifestTotal || generatedTests;
  const prepared = Math.min(generatedTests, executableResults || generatedTests);
  const preparing = Math.max(0, (executableResults || 0) - prepared);
  const blocked = Array.isArray(result.blocked) ? result.blocked.length : 0;
  const errorFindings = (result.findings || []).filter((f) => f && f.severity === 'error');
  const contractCertification = manifest.contractCertification || null;
  const contractFindings = Array.isArray(manifest.contractCertificationFindings) ? manifest.contractCertificationFindings : [];
  const percent = executableResults > 0 ? Math.round((prepared / executableResults) * 100) : (generatedTests > 0 ? 100 : 0);
  const outputAvailable = manifest.outputAvailable === true || artifactCounts.total > 0 || generatedTests > 0;
  const currentBundleId = result.runId
    ? scriptValidationRunner.safeId(result.runId, 'bundle')
    : null;
  const currentPackageHash = outputAvailable
    ? scriptValidationRunner.hashFiles(
        scriptValidationRunner.hardenPlaywrightPackageFiles(files, {
          framework: workspace && workspace.framework,
        }),
      )
    : null;
  const readiness = outputReadiness.evaluateOutputReadiness({
    outputAvailable,
    preparing,
    failedSafety: artifactCounts.failedSafety,
    exportValid: manifest.exportValid,
    packagePassed: manifest.packagePassed,
    contractCertification,
    contractFindings,
    errorFindings,
    files,
    scriptValidation,
    currentBundleId,
    currentPackageHash,
  });
  const ready = readiness.certified;
  const certificationFailed = !ready
    && !['running', 'queued'].includes(runStatus)
    && (
      manifest.exportValid === false
      || manifest.packagePassed === false
      || (contractCertification && contractCertification.packagePassed === false)
      || errorFindings.length > 0
      || contractFindings.some((f) => f && f.severity === 'error')
      || (scriptValidation && !readiness.script.passed)
    );
  const repairing = Number(certificationSummary && certificationSummary.repairing) || 0;
  const notExportable = Number(certificationSummary && certificationSummary.not_exportable) || 0;
  const withoutPipeline = Number(certificationSummary && certificationSummary.withoutPipeline) || 0;
  const certificationIssues = Array.isArray(certificationSummary && certificationSummary.issues)
    ? certificationSummary.issues
    : [];
  const needsReacquisitionCount = Math.max(notExportable, blocked);
  const runStillActive = ['running', 'queued'].includes(runStatus);
  const draftAvailable = outputAvailable && !ready;
  const scriptNotRun = readiness.script.status === 'not_run' || readiness.script.status === 'preview_only';
  const status = ready
    ? 'ready'
    : repairing > 0
      ? 'repairing'
      : draftAvailable
        ? (artifactCounts.failedSafety > 0
          ? 'safety_blocked'
          : (artifactCounts.repairNeeded > 0 || artifactCounts.failedRun > 0
            ? 'needs_repair'
            : (scriptNotRun ? 'generated_unverified' : 'draft_generated')))
        : certificationFailed
          ? 'certification_failed'
          : runStillActive
            ? 'preparing'
            : needsReacquisitionCount > 0
              ? 'reacquisition_required'
              : 'preparing';
  const phase = ready
    ? 'Scripts verified and run successfully'
    : repairing > 0
      ? 'Repairing generated flow'
      : draftAvailable
        ? (status === 'safety_blocked'
          ? 'Output blocked by safety check'
          : (status === 'needs_repair'
            ? 'Draft scripts need repair'
            : (status === 'generated_unverified' ? 'Scripts generated - not run' : 'Generated draft - validation incomplete')))
        : certificationFailed
          ? 'Code generation failed certification'
          : runStillActive
            ? 'Generating output for live run'
            : needsReacquisitionCount > 0
              ? 'Output evidence needs reacquisition'
              : blocked > 0 || preparing > 0
                ? 'Preparing output'
                : 'Certifying generated scripts';

  return {
    schema: 'qaai-output-preparation/1',
    status,
    phase,
    total: executableResults,
    prepared,
    preparing,
    blocked,
    generatedTests,
    runStatus,
    runStillActive,
    specFiles: stats && stats.byKind ? Number(stats.byKind.spec || 0) : 0,
    pageFiles: stats && stats.byKind ? Number(stats.byKind.page || 0) : 0,
    locatorFiles: stats && stats.byKind ? Number(stats.byKind.locator || 0) : 0,
    evidenceFiles: stats && stats.byKind ? Number(stats.byKind.evidence || 0) : 0,
    percent: Math.max(0, Math.min(100, percent)),
    exportValid: manifest.exportValid === true,
    packagePassed: manifest.packagePassed,
    available: readiness.available,
    downloadable: readiness.downloadable,
    generated: readiness.generated,
    verified: readiness.verified,
    runnable: readiness.runnable,
    certified: readiness.certified,
    validationStatus: readiness.script.status,
    validationCurrent: readiness.script.current,
    validationBundleMatches: readiness.script.bundleMatches,
    validationPackageHashMatches: readiness.script.packageHashMatches,
    readinessGaps: readiness.gaps,
    locatorReadiness: readiness.locator,
    contractCertification,
    artifactCounts,
    notExportable,
    withoutPipeline,
    needsReacquisition: needsReacquisitionCount,
    pendingGeneration: preparing,
    lastUpdatedAt: new Date().toISOString(),
    blockers: [],
    diagnostics: [
      ...contractFindings.slice(0, 6).map((f) => ({
        rule: f.rule || 'contract_certification_failed',
        message: f.message || 'Contract-first certification failed.',
        path: f.path || null,
        detail: f.contractStepId || f.runResultId || null,
      })),
      ...certificationIssues.slice(0, 6).map((f) => ({
        rule: f.rule || 'output_repair_gap',
        message: f.message || 'Output preparation still needs repair evidence.',
        path: f.path || null,
        detail: f.detail || null,
      })),
      ...errorFindings.slice(0, Math.max(0, 6 - certificationIssues.length)).map((f) => ({
      rule: f.rule || f.code || 'output_preparation_gap',
      message: f.message || f.detail || 'Output preparation still has a certification gap.',
      path: f.path || null,
      })),
    ],
  };
}

async function buildReplayWorkspace(req, project, { validate = false } = {}) {
  let framework;
  try {
    framework = replayFramework(req, project);
  } catch (e) {
    if (e.code === 'UNSUPPORTED_REPLAY_FRAMEWORK') {
      const err = new Error(e.message);
      err.status = 400;
      err.code = 'UNSUPPORTED_REPLAY_FRAMEWORK';
      throw err;
    }
    throw e;
  }
  const explicitRunId = replayRunId(req);
  const runResultIds = replayRunResultIds(req);
  const generationId = explicitRunId || (Array.isArray(runResultIds) && runResultIds.length)
    ? null
    : await resolveRequestedGenerationId(req, project);
  let result;
  try {
    result = await replayExport.buildReplayExport({
      projectId: project.id,
      runId: explicitRunId,
      runResultIds,
      generationId,
      framework,
      validate,
      allowIncompletePreview: true,
    });
  } catch (e) {
    if (e.code === 'UNKNOWN_FRAMEWORK') {
      const err = new Error(e.message);
      err.status = 400;
      err.code = 'UNKNOWN_FRAMEWORK';
      throw err;
    }
    throw e;
  }
  const run = result.runId
    ? await prisma.run.findFirst({
        where: { id: result.runId, projectId: project.id },
        select: RUN_SELECTOR_SELECT,
      })
    : null;
  const files = { ...(result.files || {}) };
  if (result.runId) {
    const generatedFiles = result.files || {};
    const storedBundle = Object.keys(generatedFiles).length
      ? scriptBundleStore.ensureBundle({
          projectId: project.id,
          bundleId: result.runId,
          framework,
          files: generatedFiles,
          manifest: result.manifest || null,
        })
      : scriptBundleStore.readBundle({
          projectId: project.id,
          bundleId: result.runId,
          framework,
        });
    if (storedBundle && storedBundle.files) {
      Object.assign(files, storedBundle.files);
      if (storedBundle.metadata && storedBundle.metadata.manifest) {
        result.manifest = storedBundle.metadata.manifest;
      }
    }
  }
  if (Object.keys(files).length === 0) {
    const runLabel = run?.id || result.runId || replayRunId(req) || 'latest';
    files['README.md'] = [
      '# QAAI live output workspace',
      '',
      'The selected run is still being fulfilled by the live browser agent.',
      '',
      'QAAI will keep rendering draft files from the execution contract/action graph as soon as each case persists evidence.',
      '',
      `Run: ${runLabel}`,
      `Framework: ${framework}`,
      '',
    ].join('\n');
    files['evidence/live-output-status.json'] = JSON.stringify({
      schema: 'qaai-live-output-status/1',
      runId: runLabel,
      framework,
      status: run?.status || null,
      allBlocked: !!result.allBlocked,
      admitted: Array.isArray(result.admitted) ? result.admitted.length : 0,
      blocked: Array.isArray(result.blocked) ? result.blocked.length : 0,
      message: 'Live run has not persisted exportable case evidence yet; workspace preview remains active.',
      generatedAt: new Date().toISOString(),
    }, null, 2) + '\n';
  }
  return { framework, result, run: runWithActivityFields(run), files };
}

const OUTPUT_ASSISTANT_MAX_FILE_CHARS = 16000;
const OUTPUT_ASSISTANT_MAX_JSON_CHARS = 12000;
const OUTPUT_ASSISTANT_MAX_FOCUSED_FILE_CHARS = 22000;
const OUTPUT_ASSISTANT_MAX_FOCUSED_TOTAL_CHARS = 62000;
const OUTPUT_ASSISTANT_MAX_FOCUSED_FILES = 8;

function truncateForAssistant(value, max = OUTPUT_ASSISTANT_MAX_JSON_CHARS) {
  const text = String(value == null ? '' : value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function readOutputAssistantGuides() {
  const read = (file) => {
    try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
  };
  return {
    writer: read(OUTPUT_ASSISTANT_WRITER_GUIDE),
    healer: read(OUTPUT_ASSISTANT_HEALER_GUIDE),
  };
}

function outputAssistantInventory(files = {}) {
  return Object.entries(files || {}).map(([relRaw, content]) => {
    const rel = scriptValidationRunner.safeRelPath(relRaw);
    if (!rel) return null;
    return {
      path: rel,
      kind: classifyFile(rel),
      sizeBytes: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content || ''), 'utf8'),
      binary: Buffer.isBuffer(content),
    };
  }).filter(Boolean).sort((a, b) => a.path.localeCompare(b.path));
}

function outputAssistantPickFile(files = {}, requested, report) {
  const requestedPath = scriptValidationRunner.safeRelPath(requested);
  if (requestedPath && Object.prototype.hasOwnProperty.call(files, requestedPath)) return requestedPath;
  const firstFailure = Array.isArray(report?.failures) ? report.failures.find((f) => f?.file) : null;
  const failurePath = scriptValidationRunner.safeRelPath(firstFailure?.file);
  if (failurePath && Object.prototype.hasOwnProperty.call(files, failurePath)) return failurePath;
  const entries = outputAssistantInventory(files);
  return (
    entries.find((f) => f.kind === 'spec')?.path
    || entries.find((f) => f.kind === 'page')?.path
    || entries.find((f) => f.kind === 'data')?.path
    || entries[0]?.path
    || null
  );
}

function outputAssistantFileExcerpt(files = {}, rel, maxChars = OUTPUT_ASSISTANT_MAX_FILE_CHARS) {
  if (!rel || !Object.prototype.hasOwnProperty.call(files, rel)) return null;
  const content = files[rel];
  if (Buffer.isBuffer(content)) {
    return {
      path: rel,
      kind: classifyFile(rel),
      binary: true,
      content: null,
      note: 'Binary file content is not included in chat context.',
    };
  }
  const text = String(content || '');
  return {
    path: rel,
    kind: classifyFile(rel),
    binary: false,
    sizeBytes: Buffer.byteLength(text, 'utf8'),
    lineCount: text.split(/\r?\n/).length,
    content: truncateForAssistant(text, maxChars),
  };
}

function outputAssistantMessageWantsSpecs(message) {
  return /generated test|test case|spec\b|\.spec\.|current run|read.*test|show.*test|script file/i.test(String(message || ''));
}

function outputAssistantMessageWantsData(message) {
  return /data|row|fixture|workbook|binding|csv|json|xlsx|seed/i.test(String(message || ''));
}

function outputAssistantMentionedFiles(message, inventory = []) {
  const lower = String(message || '').toLowerCase();
  if (!lower) return [];
  return inventory
    .filter((file) => {
      const rel = String(file.path || '').toLowerCase();
      const name = rel.split('/').pop();
      return rel && (lower.includes(rel) || (name && lower.includes(name)));
    })
    .map((file) => file.path);
}

function outputAssistantFocusedFiles(files = {}, inventory = [], { message, activeFilePath, report } = {}) {
  const candidates = [];
  const add = (relRaw, reason) => {
    const rel = scriptValidationRunner.safeRelPath(relRaw);
    if (!rel || !Object.prototype.hasOwnProperty.call(files, rel)) return;
    if (candidates.some((item) => item.path === rel)) return;
    candidates.push({ path: rel, reason });
  };

  outputAssistantMentionedFiles(message, inventory).forEach((rel) => add(rel, 'mentioned_by_user'));
  add(activeFilePath, 'selected_file');
  const firstFailure = Array.isArray(report?.failures) ? report.failures.find((failure) => failure?.file) : null;
  add(firstFailure?.file, 'active_validation_failure');

  if (outputAssistantMessageWantsSpecs(message)) {
    inventory
      .filter((file) => file.kind === 'spec')
      .slice(0, 5)
      .forEach((file) => add(file.path, 'generated_spec_for_question'));
  }

  if (outputAssistantMessageWantsData(message)) {
    inventory
      .filter((file) => file.kind === 'data' || /(^|\/)(data|fixtures?|seeds?)(\/|$)/i.test(file.path))
      .slice(0, 5)
      .forEach((file) => add(file.path, 'data_artifact_for_question'));
  }

  let total = 0;
  const focused = [];
  for (const candidate of candidates) {
    if (focused.length >= OUTPUT_ASSISTANT_MAX_FOCUSED_FILES) break;
    const remaining = OUTPUT_ASSISTANT_MAX_FOCUSED_TOTAL_CHARS - total;
    if (remaining < 1200) break;
    const excerpt = outputAssistantFileExcerpt(
      files,
      candidate.path,
      Math.min(OUTPUT_ASSISTANT_MAX_FOCUSED_FILE_CHARS, remaining),
    );
    if (!excerpt || excerpt.binary) continue;
    const size = String(excerpt.content || '').length;
    total += size;
    focused.push({ ...excerpt, reason: candidate.reason });
  }
  return focused;
}

function outputAssistantArtifactLists(inventory = []) {
  const scenarioFiles = inventory.filter((file) => (
    file.kind === 'spec'
    || /\.feature$/i.test(file.path)
    || /scenario|test[-_]?case|requirement|story|oracle|manifest|certification|readme/i.test(file.path)
  )).slice(0, 40);
  const dataFiles = inventory.filter((file) => (
    file.kind === 'data'
    || /data|fixture|env|seed|workbook|row/i.test(file.path)
  )).slice(0, 40);
  return { scenarioFiles, dataFiles };
}

function outputAssistantNumberedExcerpt(file, maxLines = 120) {
  if (!file || file.binary || typeof file.content !== 'string') return null;
  const lines = String(file.content || '').split(/\r?\n/);
  const shown = lines.slice(0, maxLines).map((line, index) => {
    const n = String(index + 1).padStart(3, ' ');
    return `${n}: ${line}`;
  }).join('\n');
  const suffix = lines.length > maxLines
    ? `\n... ${lines.length - maxLines} more line(s) omitted from this answer. Ask for a line range if needed.`
    : '';
  return {
    path: file.path,
    lineCount: file.lineCount || lines.length,
    excerpt: `${shown}${suffix}`,
  };
}

function outputAssistantActiveText(context) {
  const focused = Array.isArray(context?.focusedFiles) ? context.focusedFiles : [];
  const activePath = context?.activeFile?.path;
  return (
    focused.find((file) => file.path === activePath && typeof file.content === 'string')
    || focused.find((file) => typeof file.content === 'string')
    || (context?.activeFile && typeof context.activeFile.content === 'string' ? context.activeFile : null)
  );
}

function outputAssistantCodeFindings(file) {
  if (!file || file.binary || typeof file.content !== 'string') return [];
  const text = String(file.content || '');
  const lines = text.split(/\r?\n/);
  const findings = [];
  const push = (line, title, detail) => findings.push({ line, title, detail });

  if (/assertTextPresent\s*\([^,\n]+,\s*["'`][^"'`]+["'`]\s*,\s*["'`]\s*["'`]/.test(text)) {
    const idx = lines.findIndex((line) => /assertTextPresent\s*\([^,\n]+,\s*["'`][^"'`]+["'`]\s*,\s*["'`]\s*["'`]/.test(line));
    push(idx >= 0 ? idx + 1 : 1, 'Empty assertion key', 'The generated assertion passes an empty locator/key argument. That is weak evidence and can become a broad page-text check instead of a scoped oracle.');
  }
  if (/assertTextPresent\s*\(/.test(text) && !/(getByRole|getByLabel|getByText|locator|data-testid|resolveLocator)\s*\(/.test(text)) {
    push(1, 'No locator/action evidence in this file', 'The file only contains helper assertions and does not show how the page is reached or which UI element is operated. Certification must rely on the spec/action graph around it.');
  }
  if (/Successfully/i.test(text)) {
    const idx = lines.findIndex((line) => /Successfully/i.test(line));
    push(idx >= 0 ? idx + 1 : 1, 'Generic success text oracle', 'Checking only "Successfully" can pass on unrelated toast/messages. Prefer the exact expected result from the scenario plus a stable page or row signal.');
  }
  if (/No Records Found|table or/i.test(text)) {
    const idx = lines.findIndex((line) => /No Records Found|table or/i.test(line));
    push(idx >= 0 ? idx + 1 : 1, 'Broad alternate oracle', 'A single assertion that accepts either a table or "No Records Found" may hide data-binding mistakes unless the scenario explicitly allows both outcomes.');
  }
  if (/export\s+class\s+\w+/.test(text) && !/constructor\s*\([^)]*Page/.test(text)) {
    push(1, 'Page-object shape incomplete', 'This looks like a generated page/helper class but does not clearly own a Playwright Page constructor.');
  }
  if (/TODO|fixme|manual_gate|test\.fixme/i.test(text)) {
    const idx = lines.findIndex((line) => /TODO|fixme|manual_gate|test\.fixme/i.test(line));
    push(idx >= 0 ? idx + 1 : 1, 'Preview-only marker present', 'A fixme/manual marker means this bundle section should not be treated as certified until repaired and rerun.');
  }

  return findings.slice(0, 8);
}

function outputAssistantFallbackReply(message, context) {
  const text = String(message || '').toLowerCase();
  const raw = String(message || '').trim();
  const failure = Array.isArray(context?.validation?.failures) ? context.validation.failures[0] : null;
  const active = context?.activeFile;
  const inventory = Array.isArray(context?.files?.inventory) ? context.files.inventory : [];
  const dataFiles = context?.artifacts?.dataFiles || [];
  const scenarioFiles = context?.artifacts?.scenarioFiles || [];
  const focusedFiles = Array.isArray(context?.focusedFiles) ? context.focusedFiles : [];
  const focusedSpecs = focusedFiles.filter((file) => file.kind === 'spec');
  const activeText = outputAssistantActiveText(context);
  const activeExcerpt = outputAssistantNumberedExcerpt(activeText);
  const activeFindings = outputAssistantCodeFindings(activeText);
  if (/^(hi|hello|hey)\b/i.test(raw)) {
    return [
      `Hi. I am reading the selected Output Files bundle ${context?.bundle?.id || 'latest'} only.`,
      active?.path ? `Current file: ${active.path}${active.lineCount ? ` (${active.lineCount} lines)` : ''}.` : 'No current file is selected.',
      failure ? `There is an active script validation failure at ${failure.file || 'unknown'}:${failure.line || 1}.` : 'No active script validation failure is loaded.',
      'Ask me to read a file, inspect line ranges, compare generated specs with data/oracles, patch a generated line, or run script validation.',
    ].join(' ');
  }
  if (/^\/?run scripts$/i.test(raw)) {
    return 'Use Run scripts to execute this generated bundle in the isolated QAAI script runner. The live Conductor stays separate; script validation updates the Automation Script status.';
  }
  if (/(read|show|print|display|current).*?(code|file|lines?)|code\s+lines?|selected.*file/i.test(text)) {
    if (!activeExcerpt) {
      return active?.path
        ? `The selected file ${active.path} is binary or its content is not loaded in this bundle context.`
        : 'No selected output file is loaded. Select a generated file in Output Files and ask again.';
    }
    return [
      `I read ${activeExcerpt.path}: ${activeExcerpt.lineCount} line(s).`,
      '',
      '```ts',
      activeExcerpt.excerpt,
      '```',
    ].join('\n');
  }
  if (/(issue|problem|bug|wrong|smell|risk|review|what.*bad|what.*fix)/i.test(text)) {
    if (!activeText) {
      return 'I do not have a selected text file loaded. Select a generated spec/page/data file in Output Files and ask me to review it.';
    }
    if (!activeFindings.length) {
      return [
        `I inspected ${activeText.path}.`,
        'I do not see obvious static issues in the loaded excerpt. The next proof should come from running the generated Playwright scripts so QAAI can capture exact failures, traces, and file/line evidence.',
      ].join('\n');
    }
    return [
      `I inspected ${activeText.path}. Main issues I see:`,
      '',
      ...activeFindings.map((finding) => `- Line ${finding.line}: ${finding.title}. ${finding.detail}`),
      '',
      'This is a static code review of the selected generated file. Certification still needs script validation evidence.',
    ].join('\n');
  }
  if (/generated test|test case|spec file|current run|read.*test|show.*test/.test(text)) {
    const specList = scenarioFiles.filter((file) => file.kind === 'spec').map((file) => file.path).slice(0, 8);
    const firstSpec = focusedSpecs[0];
    const titles = firstSpec?.content
      ? [...String(firstSpec.content).matchAll(/\btest(?:\.only|\.skip)?\s*\(\s*['"`]([^'"`]+)['"`]/g)]
        .map((match) => match[1])
        .slice(0, 8)
      : [];
    return [
      `I am reading only the selected bundle ${context?.bundle?.id || 'latest'}, not older generations.`,
      specList.length ? `Generated spec files: ${specList.join(', ')}.` : 'I do not see generated spec files in this selected bundle inventory.',
      firstSpec ? `Loaded file context: ${firstSpec.path} (${firstSpec.lineCount || 0} lines).` : active?.path ? `Selected file: ${active.path} (${active.lineCount || 0} lines).` : 'No focused file excerpt is loaded.',
      titles.length ? `Detected test titles: ${titles.join('; ')}.` : 'No Playwright test(...) title was detected in the focused excerpt.',
    ].join(' ');
  }
  if (/^\/?(preview repair|repair active line|repair failed line)$/i.test(raw)) {
    if (failure?.repairAvailable) {
      return `I can repair the generated bundle at ${failure.file || 'unknown file'}:${failure.line || 1}, journal the before/after patch, and rerun only that failed scope.`;
    }
    return 'There is no repairable validation failure in the current bundle context. Run scripts first or select a failed validation row.';
  }
  if (/scenario|step|miss|coverage|oracle/.test(text)) {
    return `I can compare generated scripts with visible scenario/oracle artifacts. Scenario-like files: ${scenarioFiles.map((f) => f.path).slice(0, 8).join(', ') || 'none visible in bundle'}. Active file: ${active?.path || 'none selected'}.`;
  }
  if (/data|row|fixture|workbook|binding/.test(text)) {
    return `I can inspect generated data/fixture artifacts before certification. Data-like files: ${dataFiles.map((f) => f.path).slice(0, 8).join(', ') || 'none visible in bundle'}.`;
  }
  if (/line|where|open/.test(text) && failure?.file) {
    return `The active validation failure is ${failure.file}:${failure.line || 1}. Open that line, patch only the generated output file, then rerun the failed test.`;
  }
  if (/journal|history|what changed/.test(text)) {
    const repairs = context?.repairJournal?.repairs || [];
    return repairs.length
      ? `The repair journal has ${repairs.length} entr${repairs.length === 1 ? 'y' : 'ies'} with before/after hashes, reason, repairedBy, and rerun status.`
      : 'No repair journal exists for this bundle yet.';
  }
  return [
    `I can see ${inventory.length} generated output files for bundle ${context?.bundle?.id || 'latest'}.`,
    active?.path ? `Selected file: ${active.path} (${active.lineCount || 0} lines).` : 'No selected file excerpt is loaded.',
    failure ? `Current script failure: ${failure.file || 'unknown'}:${failure.line || 1}.` : 'No current script validation failure is loaded.',
  ].join(' ');
}

function buildOutputAssistantPrimer(context) {
  const activeFileMeta = context?.activeFile ? {
    path: context.activeFile.path,
    kind: context.activeFile.kind,
    binary: context.activeFile.binary,
    sizeBytes: context.activeFile.sizeBytes,
    lineCount: context.activeFile.lineCount,
  } : null;
  const promptContext = {
    project: context?.project,
    generation: context?.generation,
    bundle: context?.bundle,
    run: context?.run,
    focusedFiles: Array.isArray(context?.focusedFiles) ? context.focusedFiles : [],
    activeFile: activeFileMeta,
    files: {
      count: context?.files?.count || 0,
      inventory: Array.isArray(context?.files?.inventory) ? context.files.inventory.slice(0, 160) : [],
    },
    artifacts: context?.artifacts,
    validation: context?.validation,
    repairJournal: context?.repairJournal,
    manifest: context?.manifest,
    caseContracts: context?.caseContracts,
  };
  return [
    'You are Claude Output Agent inside QAAI Output Files.',
    '',
    'You help validate and repair GENERATED automation output, similar to a Claude VS Code extension scoped to the generated bundle.',
    '',
    'Hard boundaries:',
    '- You may discuss, inspect, and repair generated output bundle files only.',
    '- Do not claim you changed files unless the platform action applies a patch.',
    '- Do not say the website failed unless the evidence proves product behavior failed.',
    '- Separate Behavior Result from Automation Script status.',
    '- Prefer exact file/line, scenario step, data row, locator, oracle, trace, and repair-journal evidence.',
    '- If a script cannot be certified, explain Preview only vs Certified plainly.',
    '',
    'Playwright Script Writer guide:',
    truncateForAssistant(context?.assistantGuides?.writer || '', 9000),
    '',
    'Playwright Script Healer guide:',
    truncateForAssistant(context?.assistantGuides?.healer || '', 9000),
    '',
    'Context JSON:',
    truncateForAssistant(JSON.stringify(promptContext, null, 2), 76000),
  ].join('\n');
}

function decodeAssistantJsonField(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  return decodeJson(value, fallback);
}

function assistantArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function compactPhase45Contract(qualityContractJson) {
  const quality = decodeAssistantJsonField(qualityContractJson, null);
  if (!quality || typeof quality !== 'object') return null;
  const phase45 = quality.phase45 && typeof quality.phase45 === 'object' ? quality.phase45 : null;
  return {
    schema: quality.schema || null,
    role: quality.role || null,
    expectedResult: quality.expectedResult || null,
    preconditions: assistantArray(quality.preconditions).slice(0, 12),
    sessionRule: quality.sessionRule || null,
    assertionCount: quality.assertionCount ?? null,
    stepCount: quality.stepCount ?? null,
    phase45: phase45 ? {
      status: phase45.status || null,
      selfHealed: !!phase45.selfHealed,
      primaryCoverageRef: phase45.primaryCoverageRef || null,
      coverageRefs: assistantArray(phase45.coverageRefs).slice(0, 20),
      coverageAliases: assistantArray(phase45.coverageAliases).slice(0, 20),
      supportingCoverageRefs: assistantArray(phase45.supportingCoverageRefs).slice(0, 20),
      primaryStoryId: phase45.primaryStoryId || null,
      supportingRequirementRefs: assistantArray(phase45.supportingRequirementRefs).slice(0, 20),
      rowExecutionPlan: phase45.rowExecutionPlan || null,
      dataLineage: assistantArray(phase45.dataLineage).slice(0, 40),
      structuredOracles: assistantArray(phase45.structuredOracles || phase45.oracles).slice(0, 40),
      browserActionBindings: assistantArray(phase45.browserActionBindings).slice(0, 60),
      authSetupPlan: phase45.authSetupPlan || null,
      unresolvedDefects: assistantArray(phase45.unresolvedDefects).slice(0, 30),
      capabilityEvidence: assistantArray(phase45.capabilityEvidence).slice(0, 20),
    } : null,
  };
}

function compactReplayEnvelope(replayIrJson) {
  const envelope = decodeAssistantJsonField(replayIrJson, null);
  if (!envelope || typeof envelope !== 'object') return null;
  return {
    complete: envelope.complete ?? null,
    gaps: assistantArray(envelope.gaps).slice(0, 20),
    emittedAt: envelope.emittedAt || null,
    emitterVersion: envelope.emitterVersion || null,
    ir: envelope.ir ? {
      title: envelope.ir.title || null,
      status: envelope.ir.status || null,
      steps: assistantArray(envelope.ir.steps).slice(0, 30),
      assertions: assistantArray(envelope.ir.assertions).slice(0, 30),
      dataRows: assistantArray(envelope.ir.dataRows).slice(0, 12),
    } : null,
  };
}

function compactExecutionContract(value) {
  const contract = decodeAssistantJsonField(value, null);
  if (!contract || typeof contract !== 'object') return null;
  return {
    id: contract.id || null,
    title: contract.title || null,
    nodes: assistantArray(contract.nodes).slice(0, 40),
    assertions: assistantArray(contract.assertions).slice(0, 30),
    data: contract.data || null,
    blockers: assistantArray(contract.blockers).slice(0, 20),
  };
}

function redactAssistantSecrets(value, parentHints = '') {
  if (Array.isArray(value)) return value.map((item) => redactAssistantSecrets(item, parentHints));
  if (!value || typeof value !== 'object') return value;

  const hintParts = [parentHints];
  for (const [key, item] of Object.entries(value)) {
    if (/^(element|target|name|label|columnName|field|token)$/i.test(key) && typeof item === 'string') {
      hintParts.push(item);
    }
    if (key === 'field' && item && typeof item === 'object') {
      hintParts.push(String(item.name || item.label || item.target || ''));
    }
  }
  const hints = hintParts.join(' ');
  const sensitiveContext = /password|secret|credential|otp|mfa|loginpassword/i.test(hints);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const keySensitive = /password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie/i.test(key);
    const valueSlot = /^(value|valueLiteral|expected|equals|actual|text|password)$/i.test(key);
    if (typeof item === 'string' && (keySensitive || (sensitiveContext && valueSlot && !/^\{\{[^}]+\}\}$/.test(item.trim())))) {
      out[key] = '[redacted]';
    } else {
      out[key] = redactAssistantSecrets(item, hints);
    }
  }
  return out;
}

function outputAssistantCaseContractFromRow(testCase, runResult = null, source = 'generation') {
  if (!testCase) return null;
  const steps = decodeAssistantJsonField(testCase.steps, []);
  const declaredAssertions = decodeAssistantJsonField(testCase.declaredAssertions, []);
  const readinessReasons = decodeAssistantJsonField(testCase.readinessReasonsJson, []);
  const dataBinding = decodeAssistantJsonField(testCase.dataBindingJson, null);
  const rowExecutionPlan = decodeAssistantJsonField(testCase.rowExecutionPlanJson, null);
  const skippedRows = decodeAssistantJsonField(testCase.skippedRowsJson, []);
  const dependsOnIds = decodeAssistantJsonField(testCase.dependsOnIds, []);
  const producesState = decodeAssistantJsonField(testCase.producesStateJson, []);
  const requiresState = decodeAssistantJsonField(testCase.requiresStateJson, []);
  return redactAssistantSecrets({
    source,
    id: testCase.id,
    name: testCase.name,
    type: testCase.type || null,
    module: testCase.module || null,
    status: testCase.status || null,
    readinessStatus: testCase.readinessStatus || null,
    runEligibility: testCase.runEligibility || null,
    approvalEligibility: testCase.approvalEligibility || null,
    readinessReasons: assistantArray(readinessReasons).slice(0, 40),
    sessionMode: testCase.sessionMode || null,
    failurePolicy: testCase.failurePolicy || null,
    dependsOnIds: assistantArray(dependsOnIds).slice(0, 20),
    producesState: assistantArray(producesState).slice(0, 20),
    requiresState: assistantArray(requiresState).slice(0, 20),
    rowCoverageStatus: testCase.rowCoverageStatus || null,
    skippedRows: assistantArray(skippedRows).slice(0, 20),
    assertionsText: testCase.assertions || null,
    requirementRefs: decodeAssistantJsonField(testCase.requirementRefs, []),
    storyId: testCase.storyId || null,
    authProfile: testCase.authProfile || null,
    dataBinding,
    rowExecutionPlan,
    steps: assistantArray(steps).slice(0, 80),
    declaredAssertions: assistantArray(declaredAssertions).slice(0, 80),
    qualityContract: compactPhase45Contract(testCase.qualityContractJson),
    runResult: runResult ? {
      id: runResult.id,
      status: runResult.status || null,
      blockedReason: runResult.blockedReason || null,
      error: runResult.error ? String(runResult.error).slice(0, 2000) : null,
      dataRowIndex: runResult.dataRowIndex ?? null,
      dataRowLabel: runResult.dataRowLabel || null,
      dataSetName: runResult.dataSetName || null,
      exportMeta: decodeAssistantJsonField(runResult.exportMeta, null),
      replayIr: compactReplayEnvelope(runResult.replayIrJson),
      executionContract: compactExecutionContract(runResult.executionContractJson),
    } : null,
  });
}

const OUTPUT_ASSISTANT_CASE_SELECT = {
  id: true,
  name: true,
  type: true,
  module: true,
  status: true,
  assertions: true,
  steps: true,
  dependsOnIds: true,
  dataBindingJson: true,
  requirementRefs: true,
  storyId: true,
  operationsJson: true,
  authProfile: true,
  qualityContractJson: true,
  readinessStatus: true,
  readinessReasonsJson: true,
  approvalEligibility: true,
  runEligibility: true,
  sessionMode: true,
  producesStateJson: true,
  requiresStateJson: true,
  failurePolicy: true,
  rowExecutionPlanJson: true,
  rowCoverageStatus: true,
  skippedRowsJson: true,
  declaredAssertions: true,
  generationId: true,
};

async function loadOutputAssistantCaseContracts({ projectId, runId, generationId, manifest }) {
  const contracts = [];
  const seenCaseIds = new Set();

  if (runId && runId !== LEGACY_RUN_ID) {
    const rows = await prisma.runResult.findMany({
      where: { runId, run: { projectId } },
      orderBy: { createdAt: 'asc' },
      take: 40,
      select: {
        id: true,
        status: true,
        error: true,
        blockedReason: true,
        dataRowIndex: true,
        dataRowLabel: true,
        dataSetName: true,
        exportMeta: true,
        replayIrJson: true,
        executionContractJson: true,
        testCase: { select: OUTPUT_ASSISTANT_CASE_SELECT },
      },
    });
    for (const row of rows) {
      if (!row.testCase || seenCaseIds.has(row.testCase.id)) continue;
      seenCaseIds.add(row.testCase.id);
      contracts.push(outputAssistantCaseContractFromRow(row.testCase, row, 'run_result'));
    }
  }

  const manifestTestCaseIds = new Set();
  for (const entry of assistantArray(manifest?.entries)) {
    for (const id of assistantArray(entry?.testCaseIds)) {
      if (id) manifestTestCaseIds.add(id);
    }
    if (entry?.testCaseId) manifestTestCaseIds.add(entry.testCaseId);
  }
  for (const item of assistantArray(manifest?.blocked)) {
    if (item?.testCaseId) manifestTestCaseIds.add(item.testCaseId);
  }
  if (manifestTestCaseIds.size) {
    const rows = await prisma.testCase.findMany({
      where: { projectId, id: { in: [...manifestTestCaseIds].slice(0, 60) } },
      orderBy: { createdAt: 'asc' },
      select: OUTPUT_ASSISTANT_CASE_SELECT,
    });
    for (const tc of rows) {
      if (seenCaseIds.has(tc.id)) continue;
      seenCaseIds.add(tc.id);
      contracts.push(outputAssistantCaseContractFromRow(tc, null, 'manifest_case'));
    }
  }

  if (!contracts.length && generationId) {
    const rows = await prisma.testCase.findMany({
      where: { projectId, generationId },
      orderBy: { createdAt: 'asc' },
      take: 40,
      select: OUTPUT_ASSISTANT_CASE_SELECT,
    });
    for (const tc of rows) {
      if (seenCaseIds.has(tc.id)) continue;
      seenCaseIds.add(tc.id);
      contracts.push(outputAssistantCaseContractFromRow(tc, null, 'generation_case'));
    }
  }

  return {
    count: contracts.length,
    source: runId ? 'run_result' : (generationId ? 'generation' : 'manifest'),
    cases: contracts.slice(0, 40),
  };
}

function repairLinePreview(before, after, line) {
  const beforeLines = String(before || '').split(/\r?\n/);
  const afterLines = String(after || '').split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);
  const changed = [];
  for (let i = 0; i < max; i += 1) {
    if ((beforeLines[i] || '') !== (afterLines[i] || '')) {
      changed.push({
        line: i + 1,
        before: beforeLines[i] || '',
        after: afterLines[i] || '',
      });
      if (changed.length >= 12) break;
    }
  }
  const targetLine = Number(line || changed[0]?.line || 1);
  return {
    changedLineCount: changed.length,
    changed,
    target: {
      line: targetLine,
      before: beforeLines[targetLine - 1] || '',
      after: afterLines[targetLine - 1] || '',
    },
  };
}

function repairProposalPayload({ proposal, failure, effectiveBundleId, framework }) {
  return {
    status: proposal.status,
    bundleId: effectiveBundleId,
    framework,
    failureId: failure?.id || null,
    file: proposal.file || failure?.file || null,
    line: Number(failure?.line || 1),
    reason: proposal.reason || null,
    repairedBy: proposal.repairedBy || null,
    before: proposal.before || null,
    after: proposal.after || null,
    diff: proposal.before && proposal.after
      ? repairLinePreview(proposal.before, proposal.after, failure?.line)
      : null,
  };
}

function parseProviderJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (!candidate || !candidate.trim().startsWith('{')) return null;
  try { return JSON.parse(candidate); } catch (_) { return null; }
}

function slugForOutputFile(value, fallback = 'generated-test') {
  const raw = String(value || fallback).toLowerCase();
  return raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback;
}

function defaultScriptPathForFramework(framework, scenarioCase) {
  const adapter = String(framework || '').toLowerCase();
  const slug = slugForOutputFile(scenarioCase?.name || scenarioCase?.id || 'generated-test');
  if (/bdd|cucumber/.test(adapter)) return `features/${slug}.feature`;
  const ext = /(?:-js|javascript|selenium)/.test(adapter) ? 'js' : 'ts';
  return `tests/${slug}.spec.${ext}`;
}

function escapeJsString(value) {
  return JSON.stringify(String(value == null ? '' : value));
}

function tokenValueExpression(rawValue) {
  const text = String(rawValue == null ? '' : rawValue);
  const token = text.match(/^\{\{\s*([^}]+?)\s*\}\}$/)?.[1]?.trim();
  if (!token) return escapeJsString(text);
  const env = token.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'VALUE';
  if (/password|secret/i.test(token)) return `process.env.${env} || 'TODO_${env}'`;
  return `process.env.${env} || 'TODO_${env}'`;
}

function locatorExpressionForStep(step) {
  const label = String(step?.element || step?.target || step?.locator_hint || '').trim();
  const locator = String(step?.locator_hint || '').trim();
  const verify = step?.verify || {};
  if (locator && /^[#.[]/.test(locator)) return `page.locator(${escapeJsString(locator)}).first()`;
  if (verify?.element?.role && verify?.element?.name) {
    return `page.getByRole(${escapeJsString(verify.element.role)}, { name: ${escapeJsString(verify.element.name)} })`;
  }
  if (/email|username|user name|phone|skype/i.test(label)) return `page.getByLabel(/${label.includes('/') ? 'email|phone|skype' : 'email|username|user name'}/i).first()`;
  if (/password/i.test(label)) return `page.getByLabel(/password/i).first()`;
  if (/button|continue|sign in|submit|next|save|add/i.test(label)) {
    const name = normalizeInteractiveControlName(label);
    return `page.getByRole('button', { name: /${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/i }).first()`;
  }
  if (label) return `page.getByText(${escapeJsString(label)}, { exact: false }).first()`;
  return 'page.locator("body")';
}

function deterministicPlaywrightSpecFromContract({ scenarioCase, project, framework }) {
  if (/bdd|cucumber/i.test(String(framework || ''))) {
    const title = scenarioCase?.name || 'Generated QAAI test case';
    const steps = assistantArray(scenarioCase?.steps).slice(0, 30);
    const lines = [
      `Feature: ${title}`,
      '',
      '  # Preview feature created by QAAI Output Files assistant from the saved TestCase contract.',
      '  # Bind these steps to Playwright step definitions before certification.',
      `  Scenario: ${title}`,
    ];
    if (project?.baseUrl) lines.push(`    Given I open "${project.baseUrl}"`);
    for (const step of steps) {
      const action = String(step?.action || '').toLowerCase();
      const target = String(step?.element || step?.target || step?.expected || 'the page').trim();
      if (/navigate|goto|open/.test(action)) lines.push(`    Given I navigate to "${step?.value || target}"`);
      else if (/fill|type|enter|input/.test(action)) lines.push(`    When I fill "${target}" with "${step?.value || ''}"`);
      else if (/click|press|submit|select|choose/.test(action)) lines.push(`    When I click "${target}"`);
      else if (/verify|assert|expect/.test(action)) lines.push(`    Then I should see "${step?.expected || target}"`);
      else lines.push(`    And I perform "${step?.action || 'action'}" on "${target}"`);
    }
    return `${lines.join('\n')}\n`;
  }
  const isJs = /(?:-js|javascript)/i.test(String(framework || ''));
  const steps = assistantArray(scenarioCase?.steps).slice(0, 80);
  const assertions = assistantArray(scenarioCase?.declaredAssertions);
  const title = scenarioCase?.name || 'Generated QAAI test case';
  const baseUrl = project?.baseUrl || '';
  const lines = [];
  lines.push(isJs ? "const { test, expect } = require('@playwright/test');" : "import { test, expect } from '@playwright/test';");
  lines.push('');
  lines.push('// Preview script created by QAAI Output Files assistant from the saved TestCase contract.');
  lines.push('// Run script validation before treating this file as certified output.');
  lines.push('');
  lines.push(`test(${escapeJsString(title)}, async ({ page }) => {`);
  if (baseUrl) lines.push(`  test.info().annotations.push({ type: 'qaai.baseUrl', description: ${escapeJsString(baseUrl)} });`);
  for (const step of steps) {
    const action = String(step?.action || step?.stepKind || '').toLowerCase();
    const label = String(step?.element || step?.target || `step ${step?.order || ''}`).trim() || 'step';
    lines.push(`  await test.step(${escapeJsString(`${step?.order || ''} ${label}`.trim())}, async () => {`);
    if (/navigate|goto|open/.test(action)) {
      const url = String(step?.value || step?.target || step?.expected || '').trim();
      lines.push(`    await page.goto(${escapeJsString(url || baseUrl || '/')});`);
    } else if (/fill|type|enter|input/.test(action)) {
      lines.push(`    await ${locatorExpressionForStep(step)}.fill(${tokenValueExpression(step?.value)});`);
    } else if (/click|press|submit|select|choose/.test(action)) {
      lines.push(`    await ${locatorExpressionForStep(step)}.click();`);
    } else if (/dismiss/.test(action)) {
      lines.push("    const optionalPrompt = page.getByRole('button', { name: /^(No|Continue|Yes|OK|Cancel)$/i }).first();");
      lines.push("    await optionalPrompt.click({ timeout: 3000 }).catch(() => {});");
    } else if (/verify|assert|expect/.test(action)) {
      const expected = step?.verify?.text || step?.expected || step?.target || label;
      lines.push(`    await expect(page.getByText(${escapeJsString(expected)}, { exact: false }).first()).toBeVisible();`);
    } else {
      lines.push(`    // TODO: Unsupported generated action ${escapeJsString(step?.action || 'unknown')} for ${escapeJsString(label)}.`);
    }
    const verifyText = step?.verify?.text || (step?.verificationPoint ? step?.expected : null);
    if (verifyText && !/verify|assert|expect/.test(action)) {
      lines.push(`    await expect(page.getByText(${escapeJsString(verifyText)}, { exact: false }).first()).toBeVisible();`);
    }
    lines.push('  });');
  }
  const endAssertions = assertions.filter((a) => String(a?.checkAt || '').toLowerCase() === 'end').slice(0, 5);
  for (const assertion of endAssertions) {
    const expected = assertion?.payload?.expectedText || assertion?.payload?.text || assertion?.note;
    if (expected) lines.push(`  await expect(page.getByText(${escapeJsString(expected)}, { exact: false }).first()).toBeVisible();`);
  }
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

async function tryProviderGeneratedFileCreate({ req, project, context, scenarioCase, requestedFile, instruction }) {
  let resolved;
  try {
    resolved = await resolveAiCredentials(req.user.id, project);
  } catch (_) {
    return null;
  }
  if (!resolved?.apiKey || resolved.integration?.status !== 'valid') return null;

  try {
    const provider = getProvider(resolved.provider);
    const prompt = [
      'Return only JSON for one new generated output bundle file.',
      '',
      'Schema:',
      '{"status":"created"|"manual_gate","file":"tests/name.spec.ts","content":"complete file content","reason":"..."}',
      '',
      'Rules:',
      '- Create exactly one generated automation file inside the selected Output Files bundle.',
      '- Use the selected framework/adapter from context.bundle.framework.',
      '- Use QAAI caseContracts.steps, declaredAssertions, dataBinding, authSetupPlan, and structuredOracles.',
      '- Do not invent credentials or expected business outcomes. Use env/token placeholders for unresolved data.',
      '- If the selected framework is unsupported from the context, return manual_gate.',
      '- Do not return markdown or prose outside JSON.',
      '',
      'Playwright Script Writer guide:',
      truncateForAssistant(context?.assistantGuides?.writer || '', 9000),
      '',
      `Requested file: ${requestedFile || '(choose appropriate path)'}`,
      `Instruction: ${instruction || 'Create a complete script from the saved QAAI test case contract.'}`,
      '',
      'Context:',
      truncateForAssistant(JSON.stringify({
        project: context?.project,
        generation: context?.generation,
        bundle: context?.bundle,
        run: context?.run,
        validation: context?.validation,
        manifest: context?.manifest,
        selectedCase: scenarioCase,
      }, null, 2), 50000),
    ].join('\n');

    const resp = await provider.complete({
      apiKey: resolved.apiKey,
      model: resolved.model,
      maxTokens: 5000,
      system: 'You are Claude Output Agent create-file mode. Produce one complete generated automation file as JSON only.',
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (resp?.content?.find?.((block) => block?.type === 'text')?.text || resp?.content?.[0]?.text || resp?.text || '').trim();
    const parsed = parseProviderJson(text);
    if (!parsed || parsed.status !== 'created') return null;
    const file = scriptValidationRunner.safeRelPath(parsed.file || requestedFile);
    if (!file || typeof parsed.content !== 'string' || !parsed.content.trim() || parsed.content.length > 300000) return null;
    return {
      status: 'created',
      file,
      content: parsed.content,
      reason: String(parsed.reason || 'Provider created a generated automation file from the QAAI case contract.').slice(0, 800),
      repairedBy: `provider_${resolved.provider || 'claude'}_create_file`,
    };
  } catch (_) {
    return null;
  }
}

async function tryProviderScriptRepairProposal({ req, project, failure, storedBundle, context }) {
  const file = scriptValidationRunner.safeRelPath(failure?.file);
  if (!file || !storedBundle?.files || storedBundle.files[file] == null || Buffer.isBuffer(storedBundle.files[file])) {
    return null;
  }
  const fileContent = String(storedBundle.files[file] || '');
  const lines = fileContent.split(/\r?\n/);
  const line = Math.max(1, Math.min(lines.length, Number(failure?.line || 1)));
  const beforeLine = lines[line - 1] || '';
  const windowStart = Math.max(1, line - 8);
  const windowEnd = Math.min(lines.length, line + 8);
  const numberedWindow = lines
    .slice(windowStart - 1, windowEnd)
    .map((text, idx) => `${windowStart + idx}: ${text}`)
    .join('\n');

  let resolved;
  try {
    resolved = await resolveAiCredentials(req.user.id, project);
  } catch (_) {
    return null;
  }
  if (!resolved?.apiKey || resolved.integration?.status !== 'valid') return null;

  try {
    const provider = getProvider(resolved.provider);
    const prompt = [
      'Return only JSON for one safe generated-file patch.',
      '',
      'Schema:',
      '{"status":"patched"|"manual_gate","file":"...","line":1,"beforeLine":"...","afterLine":"...","reason":"..."}',
      '',
      'Rules:',
      '- Patch only the listed generated output file and one line unless absolutely impossible.',
      '- The afterLine must be the complete replacement line, not a diff.',
      '- If the fix needs more context or could change product behavior, return manual_gate.',
      '- Prefer Playwright role/label/test-id locators and explicit assertions.',
      '',
      `Failure: ${JSON.stringify({
        id: failure?.id || null,
        testTitle: failure?.testTitle || null,
        file,
        line,
        code: failure?.code || beforeLine,
        error: failure?.error || null,
        tracePath: failure?.tracePath || null,
        screenshotPath: failure?.screenshotPath || null,
      })}`,
      '',
      `Current line ${line}: ${beforeLine}`,
      '',
      'Nearby file window:',
      numberedWindow,
      '',
      'Bundle context:',
      truncateForAssistant(JSON.stringify({
        project: context?.project,
        bundle: context?.bundle,
        run: context?.run,
        validation: context?.validation,
        artifacts: context?.artifacts,
        focusedFiles: Array.isArray(context?.focusedFiles) ? context.focusedFiles.map((f) => ({
          path: f.path,
          kind: f.kind,
          reason: f.reason,
          lineCount: f.lineCount,
          content: f.path === file ? undefined : truncateForAssistant(f.content, 4000),
        })) : [],
      }, null, 2), 18000),
    ].join('\n');

    const resp = await provider.complete({
      apiKey: resolved.apiKey,
      model: resolved.model,
      maxTokens: 900,
      system: 'You are Claude Output Agent repair mode. Produce a bounded JSON patch for generated Playwright output. Never return prose outside JSON.',
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (resp?.content?.find?.((block) => block?.type === 'text')?.text || resp?.content?.[0]?.text || resp?.text || '').trim();
    const parsed = parseProviderJson(text);
    if (!parsed || parsed.status !== 'patched') return null;
    const parsedFile = scriptValidationRunner.safeRelPath(parsed.file);
    if (parsedFile !== file) return null;
    const parsedLine = Number(parsed.line || line);
    if (parsedLine !== line) return null;
    if (typeof parsed.afterLine !== 'string' || !parsed.afterLine.trim() || parsed.afterLine.length > 2000) return null;
    if (parsed.beforeLine != null && String(parsed.beforeLine) !== beforeLine) return null;
    return {
      status: 'patched',
      file,
      before: fileContent,
      after: scriptRepairAgent.replaceLine(fileContent, line, parsed.afterLine),
      reason: String(parsed.reason || 'Provider proposed a bounded one-line generated-script repair.').slice(0, 500),
      repairedBy: `provider_${resolved.provider || 'claude'}_script_repair`,
    };
  } catch (_) {
    return null;
  }
}

async function tryProviderFullFileRewrite({ req, project, file, fileContent, instruction, context }) {
  let resolved;
  try {
    resolved = await resolveAiCredentials(req.user.id, project);
  } catch (_) {
    return null;
  }
  if (!resolved?.apiKey || resolved.integration?.status !== 'valid') return null;

  const guides = readOutputAssistantGuides();
  const lineCount = String(fileContent || '').split(/\r?\n/).length;
  const prompt = [
    'Return only JSON for one full-file rewrite of a generated Playwright output bundle file.',
    '',
    'Schema:',
    '{"status":"rewritten"|"manual_gate","file":"...","after":"complete replacement file content","reason":"..."}',
    '',
    'Rules:',
    '- Rewrite only the requested generated output file.',
    '- The "after" field must be the full replacement file content, not a diff and not markdown.',
    '- Keep imports/exports/test titles compatible unless the user specifically asks to change them.',
    '- Preserve QAAI scenario intent, test data binding, and certification evidence.',
    '- If the rewrite cannot be done safely from the provided evidence, return manual_gate.',
    '- Do not edit QAAI platform source code.',
    '',
    'Playwright Script Writer guide:',
    truncateForAssistant(guides.writer, 9000),
    '',
    'Playwright Script Healer guide:',
    truncateForAssistant(guides.healer, 9000),
    '',
    `User instruction: ${instruction || 'Rewrite/fix this generated file safely.'}`,
    '',
    `Target file: ${file}`,
    `Target file line count: ${lineCount}`,
    '',
    'Current file content:',
    truncateForAssistant(fileContent, 50000),
    '',
    'Bundle context:',
    truncateForAssistant(JSON.stringify({
      project: context?.project,
      generation: context?.generation,
      bundle: context?.bundle,
      run: context?.run,
      validation: context?.validation,
      artifacts: context?.artifacts,
      focusedFiles: Array.isArray(context?.focusedFiles) ? context.focusedFiles.map((f) => ({
        path: f.path,
        kind: f.kind,
        reason: f.reason,
        lineCount: f.lineCount,
        content: f.path === file ? undefined : truncateForAssistant(f.content, 7000),
      })) : [],
      manifest: context?.manifest,
    }, null, 2), 24000),
  ].join('\n');

  try {
    const provider = getProvider(resolved.provider);
    const resp = await provider.complete({
      apiKey: resolved.apiKey,
      model: resolved.model,
      maxTokens: 5000,
      system: 'You are Claude Output Agent full-file rewrite mode. Produce strict JSON only. You may rewrite generated Playwright output files, never QAAI source files.',
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (resp?.content?.find?.((block) => block?.type === 'text')?.text || resp?.content?.[0]?.text || resp?.text || '').trim();
    const parsed = parseProviderJson(text);
    if (!parsed || parsed.status !== 'rewritten') return null;
    const parsedFile = scriptValidationRunner.safeRelPath(parsed.file);
    if (parsedFile !== file) return null;
    if (typeof parsed.after !== 'string' || !parsed.after.trim() || parsed.after.length > 300000) return null;
    return {
      status: 'rewritten',
      file,
      after: parsed.after,
      reason: String(parsed.reason || 'Provider rewrote the generated output file using the QAAI writer/healer guides.').slice(0, 800),
      repairedBy: `provider_${resolved.provider || 'claude'}_full_file_rewrite`,
    };
  } catch (_) {
    return null;
  }
}

async function buildOutputAssistantContext(req, project, { bundleId, activeFilePath, message } = {}) {
  const cleanBundle = String(bundleId || 'latest').trim() || 'latest';
  const runIdFromBundle = cleanBundle && !['latest', LEGACY_RUN_ID].includes(cleanBundle) ? cleanBundle : null;
  const runReq = {
    ...req,
    query: {
      ...(req.query || {}),
      source: REPLAYIR_SOURCE,
      ...(runIdFromBundle && !req.query?.runId ? { runId: runIdFromBundle } : {}),
    },
  };
  const workspace = await buildReplayWorkspace(runReq, project, { validate: false });
  const effectiveBundleId = workspace.result.runId || cleanBundle || 'latest';
  const storedBundle = scriptBundleStore.ensureBundle({
    projectId: project.id,
    bundleId: effectiveBundleId,
    framework: workspace.framework,
    files: workspace.files || {},
    manifest: workspace.result.manifest || null,
  });
  const files = storedBundle.files || workspace.files || {};
  const inventory = outputAssistantInventory(files);
  const report = scriptValidationRunner.readLatestValidationReport({
    projectId: project.id,
    bundleId: effectiveBundleId,
  });
  if (report && storedBundle.journal?.repairs?.length) report.repairJournal = storedBundle.journal;
  const selectedPath = outputAssistantPickFile(files, activeFilePath, report);
  const activeFile = outputAssistantFileExcerpt(files, selectedPath);
  const manifest = storedBundle.metadata?.manifest || workspace.result.manifest || null;
  const scriptArtifacts = scriptArtifactsFromManifest(manifest || {}, files).slice(0, 160);
  const activeScriptArtifact = scriptArtifacts.find((artifact) => String(artifact && artifact.file || '') === String(selectedPath || '')) || null;
  const artifacts = {
    ...outputAssistantArtifactLists(inventory),
    scriptArtifacts,
    activeScriptArtifact,
  };
  const focusedFiles = outputAssistantFocusedFiles(files, inventory, {
    message,
    activeFilePath: selectedPath,
    report,
  });
  const generationId = req.query?.generationId || workspace.result.generationId || null;
  const caseContracts = await loadOutputAssistantCaseContracts({
    projectId: project.id,
    runId: workspace.result.runId || runIdFromBundle || null,
    generationId,
    manifest,
  });
  return {
    project: {
      id: project.id,
      name: project.name || null,
      baseUrl: project.baseUrl || project.targetUrl || null,
    },
    generation: {
      id: generationId,
    },
    bundle: {
      id: effectiveBundleId,
      framework: workspace.framework,
      sourceHash: storedBundle.metadata?.sourceHash || null,
      currentHash: storedBundle.currentHash || storedBundle.metadata?.currentHash || null,
      repairCount: storedBundle.journal?.repairs?.length || 0,
    },
    run: workspace.run ? serialiseRun(workspace.run) : null,
    files: {
      count: inventory.length,
      inventory: inventory.slice(0, 250),
    },
    activeFile,
    focusedFiles,
    artifacts,
    assistantGuides: readOutputAssistantGuides(),
    validation: report ? {
      id: report.id || null,
      status: report.status || null,
      reason: report.reason || null,
      summary: report.summary || null,
      failures: Array.isArray(report.failures) ? report.failures.slice(0, 8) : [],
    } : null,
    repairJournal: storedBundle.journal || null,
    manifest,
    caseContracts,
  };
}

// ── GET tree ──────────────────────────────────────────────
//
// Returns the playwright workspace as a tree the UI can render as a
// VS Code-style file explorer. The orgId / requireOrg auth gate still
// fronts this; the disk path itself is shared across projects in this
// single-tenant install — multi-tenant isolation is a future concern.
router.get('/', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    if (wantsReplayIr(req)) {
      const workspace = await buildReplayWorkspace(req, project, { validate: false });
      // For the tree view, always show files — don't block on exportValid.
      // Readiness/certification metadata never hides files; only a real secret leak is refused.
      const root = treeFromFiles(workspace.files, workspace.result.runId);
      const stats = summariseTree(root);
      const errorFindings = (workspace.result.findings || []).filter(f => f.severity === 'error');
      const certificationSummary = workspace.result.runId
        ? await computeCertSummary(workspace.result.runId)
        : null;
      const locatorAtlas = locatorAtlasFromWorkspace(workspace);
      const scriptValidation = workspace.result.runId
        ? scriptValidationRunner.readLatestValidationReport({
            projectId: project.id,
            bundleId: workspace.result.runId,
          })
        : null;
      const outputPreparation = buildOutputPreparationSummary({
        workspace,
        stats,
        certificationSummary,
        scriptValidation,
      });
      const scriptBundle = workspace.result.runId
        ? scriptBundleStore.readBundle({
            projectId: project.id,
            bundleId: workspace.result.runId,
            framework: workspace.framework,
          })
        : null;
      if (scriptValidation && scriptBundle?.journal?.repairs?.length) {
        scriptValidation.repairJournal = scriptBundle.journal;
      }
      return res.json({
        success: true,
        source: REPLAYIR_SOURCE,
        framework: workspace.framework,
        tree: root,
        stats,
        empty: stats.files === 0,
        run: workspace.run ? serialiseRun(workspace.run) : null,
        manifest: workspace.result.manifest || null,
        findings: workspace.result.findings || [],
        exportBlocked: false,
        exportBlockReason: errorFindings.length ? errorFindings[0].rule : null,
        exportBlockDetail: errorFindings.length ? errorFindings[0].message : null,
        certificationSummary,
        outputPreparation,
        locatorAtlas,
        scriptValidation,
      });
    }

    const { run, runDir } = await resolveTargetRun(req, project);
    // No runs ever executed for this project, or the run dir doesn't exist
    // on disk yet (the run started but the conductor hasn't emitted any
    // files — e.g. all cases blocked before reaching pomEmitter).
    if (!run || !runDir || !fs.existsSync(runDir)) {
      return res.json({
        success: true,
        tree: { name: run ? `run-${run.id.slice(0, 8)}` : 'playwright', type: 'dir', path: '', children: [] },
        stats: { files: 0, dirs: 0, totalSize: 0, byKind: {} },
        empty: true,
        run: run ? serialiseRun(run) : null,
      });
    }

    // Walk this run's self-contained workspace. Same TOP_LEVEL_DIRS /
    // TOP_LEVEL_FILES policy as before — we want the agent's user-visible
    // workspace, not result/cache subtrees.
    const root = { name: `run-${run.id.slice(0, 8)}`, type: 'dir', path: '', children: [] };
    for (const dir of TOP_LEVEL_DIRS) {
      const abs = path.join(runDir, dir);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        root.children.push(walkTree(abs, dir));
      }
    }
    for (const file of TOP_LEVEL_FILES) {
      const abs = path.join(runDir, file);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const st = fs.statSync(abs);
        root.children.push({
          name: file,
          path: file,
          type: 'file',
          sizeBytes: st.size,
          mtime: st.mtime,
          kind: classifyFile(file),
        });
      }
    }
    // Any other directory the user / agent created inside the run dir.
    for (const e of fs.readdirSync(runDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (TOP_LEVEL_DIRS.includes(e.name)) continue;
      if (HIDDEN_TOP.has(e.name)) continue;
      if (e.name.startsWith('.')) continue;
      root.children.push(walkTree(path.join(runDir, e.name), e.name));
    }

    const stats = summariseTree(root);
    const empty = stats.files === 0;
    res.json({ success: true, tree: root, stats, empty, run: serialiseRun(run) });
  } catch (err) {
    next(err);
  }
});

// ── GET /runs ─────────────────────────────────────────────
// List runs available for this project, newest first. Powers the
// per-run selector on Output Files.
router.get('/runs', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const generationId = await resolveRequestedGenerationId(req, project);
    if (wantsReplayIr(req)) {
      const runs = await prisma.run.findMany({
        where: { projectId: project.id, ...(generationId ? { generationId } : {}) },
        orderBy: { startedAt: 'desc' },
        select: RUN_SELECTOR_SELECT,
        take: 40,
      });
      return res.json({
        success: true,
        source: REPLAYIR_SOURCE,
        framework: replayFramework(req),
        runs: runs
          .map((r) => {
            const projected = runWithActivityFields(r);
            return {
              ...serialiseRun(projected),
              hasOutput: true,
              hasReplayEvidence: !!(
                projected.outputEvidence?.replayIr ||
                projected.outputEvidence?.executionContract ||
                projected.outputEvidence?.actionGraph ||
                projected.outputEvidence?.exportMeta
              ),
              source: REPLAYIR_SOURCE,
            };
          })
          .sort((a, b) => (new Date(b.lastActivityAt || 0).getTime()) - (new Date(a.lastActivityAt || 0).getTime()))
          .slice(0, 20),
      });
    }
    // Only return runs that ACTUALLY produced files on disk. An empty
    // dropdown entry is just noise — it can't show anything when picked.
    // Cap to 20 most-recent files-bearing runs to keep the selector tidy.
    const candidates = await prisma.run.findMany({
      where: { projectId: project.id, ...(generationId ? { generationId } : {}) },
      orderBy: { startedAt: 'desc' },
      select: RUN_SELECTOR_SELECT,
      take: 40,
    });
    const withOutput = [];
    for (const r of candidates) {
      if (withOutput.length >= 20) break;
      if (dirHasAnyFiles(path.join(RUNS_DIR, r.id))) {
        withOutput.push({ ...serialiseRun(runWithActivityFields(r)), hasOutput: true });
      }
    }
    withOutput.sort((a, b) => (new Date(b.lastActivityAt || 0).getTime()) - (new Date(a.lastActivityAt || 0).getTime()));
    // Surface the legacy workspace (playwright/pages + playwright/tests)
    // as its own entry IF it has files. Anchored last so per-run rows
    // appear first.
    if (dirHasAnyFiles(PLAYWRIGHT_DIR)) {
      withOutput.push({ ...serialiseRun(legacyWorkspaceRow()), hasOutput: true });
    }
    res.json({ success: true, runs: withOutput });
  } catch (err) {
    next(err);
  }
});

// -- POST /:bundleId/run -----------------------------------------------------
// Phase 6: run the generated ReplayIR Playwright bundle inside a temporary
// validation workspace and persist exact script-run evidence. `bundleId` maps
// to the run/export bundle id; use "latest" with query params to let the
// existing resolver choose the newest exportable run.
router.post('/:bundleId/run', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const bundleId = String(req.params.bundleId || '').trim();
    const runIdFromBundle = bundleId && !['latest', LEGACY_RUN_ID].includes(bundleId) ? bundleId : null;
    const runReq = {
      ...req,
      query: {
        ...(req.query || {}),
        source: REPLAYIR_SOURCE,
        ...(runIdFromBundle && !req.query?.runId ? { runId: runIdFromBundle } : {}),
      },
    };

    const workspace = await buildReplayWorkspace(runReq, project, { validate: true });
    const effectiveBundleId = workspace.result.runId || bundleId || 'latest';
    const storedBundle = scriptBundleStore.ensureBundle({
      projectId: project.id,
      bundleId: effectiveBundleId,
      framework: workspace.framework,
      files: workspace.files || {},
      manifest: workspace.result.manifest || null,
    });

    const scopedEnv = req.body && typeof req.body.env === 'object' && req.body.env
      ? req.body.env
      : {};
    if (req.body?.async === true || req.body?.mode === 'auto_after_generation') {
      const send = req.app.locals.broadcastToUser;
      const job = scriptValidationAgent.enqueueScriptValidation({
        projectId: project.id,
        runId: workspace.result.runId || null,
        bundleId: effectiveBundleId,
        framework: workspace.framework,
        files: storedBundle.files || workspace.files || {},
        mode: req.body?.mode || 'user_run',
        scopedEnv,
        onEvent: (event) => {
          if (!send) return;
          send(req.user.id, {
            ...event,
            projectId: project.id,
            runId: workspace.result.runId || null,
            bundleId: effectiveBundleId,
          });
        },
      });

      await audit.log({
        userId: req.user.id,
        action: 'output.scripts.queue',
        target: project.id,
        metadata: {
          runId: workspace.result.runId || null,
          bundleId: effectiveBundleId,
          jobId: job.id,
          framework: workspace.framework,
          mode: job.mode,
        },
        req,
      });

      return res.status(202).json({
        success: true,
        source: REPLAYIR_SOURCE,
        framework: workspace.framework,
        runId: workspace.result.runId || null,
        job,
      });
    }

    const report = await scriptValidationRunner.runScriptValidation({
      projectId: project.id,
      bundleId: effectiveBundleId,
      framework: workspace.framework,
      files: storedBundle.files || workspace.files || {},
      mode: req.body?.mode || 'user_run',
      scopedEnv,
    });
    scriptBundleStore.applyValidationReport({
      projectId: project.id,
      bundleId: report.bundleId || effectiveBundleId,
      framework: report.framework || workspace.framework,
      report,
    });
    if (storedBundle.journal?.repairs?.length) report.repairJournal = storedBundle.journal;

    await audit.log({
      userId: req.user.id,
      action: 'output.scripts.run',
      target: project.id,
      metadata: {
        runId: workspace.result.runId || null,
        bundleId: report.bundleId,
        jobId: report.id,
        framework: workspace.framework,
        status: report.status,
        failed: report.summary?.failed || 0,
      },
      req,
    });

    const send = req.app.locals.broadcastToUser;
    if (send) {
      send(req.user.id, {
        type: 'output.scriptValidationComplete',
        projectId: project.id,
        runId: workspace.result.runId || null,
        bundleId: report.bundleId,
        jobId: report.id,
        status: report.status,
        summary: report.summary,
        failures: report.failures,
      });
    }

    return res.json({
      success: true,
      source: REPLAYIR_SOURCE,
      framework: workspace.framework,
      runId: workspace.result.runId || null,
      job: report,
    });
  } catch (err) {
    if (/script_validation_env_denied/i.test(String(err && err.message))) {
      return res.status(400).json({
        success: false,
        code: 'SCRIPT_VALIDATION_ENV_DENIED',
        message: 'Script validation refused a platform/private environment variable. Use scoped test credentials only.',
      });
    }
    next(err);
  }
});

// -- GET /:bundleId/script-validation-jobs/:jobId ---------------------------
router.get('/:bundleId/script-validation-jobs/:jobId', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const job = scriptValidationAgent.getJob(req.params.jobId);
    if (!job || job.projectId !== project.id) {
      return res.status(404).json({ success: false, code: 'SCRIPT_VALIDATION_JOB_NOT_FOUND' });
    }
    res.json({ success: true, job });
  } catch (err) {
    next(err);
  }
});

// -- GET /:bundleId/assistant/context ---------------------------------------
// Bundle-scoped context for the Output Files Claude-style assistant. This is
// intentionally read-only: it exposes the same stored/repaired bundle files the
// user sees and downloads.
router.get('/:bundleId/assistant/context', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const context = await buildOutputAssistantContext(req, project, {
      bundleId: req.params.bundleId,
      activeFilePath: req.query?.file,
      message: req.query?.message,
    });
    res.json({ success: true, context });
  } catch (err) {
    next(err);
  }
});

// -- POST /:bundleId/assistant/chat -----------------------------------------
// Text chat for the Output Files assistant. Provider-backed when configured,
// deterministic fallback when not, so the UI never becomes a dead panel.
router.post(
  '/:bundleId/assistant/chat',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 30 }),
  async (req, res, next) => {
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const message = String(req.body?.message || '').trim();
      if (!message) {
        return res.status(400).json({ success: false, code: 'EMPTY_MESSAGE', message: 'Message is required.' });
      }
      if (message.length > 4000) {
        return res.status(400).json({ success: false, code: 'MESSAGE_TOO_LONG', message: 'Limit messages to 4,000 characters.' });
      }

      const context = await buildOutputAssistantContext(req, project, {
        bundleId: req.params.bundleId,
        activeFilePath: req.body?.activeFilePath,
        message,
      });

      let reply = null;
      let mode = 'provider';
      let providerName = null;
      try {
        const resolved = await resolveAiCredentials(req.user.id, project);
        providerName = resolved.provider;
        if (!resolved.apiKey || resolved.integration?.status !== 'valid') {
          mode = 'deterministic_fallback';
          reply = outputAssistantFallbackReply(message, context);
        } else {
          const provider = getProvider(resolved.provider);
          const priorTurns = (Array.isArray(req.body?.history) ? req.body.history : [])
            .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .slice(-12)
            .map((m) => ({ role: m.role, content: truncateForAssistant(m.content, 3000) }));
          const resp = await provider.complete({
            apiKey: resolved.apiKey,
            model: resolved.model,
            maxTokens: 1000,
            system: 'You are Claude Output Agent for QAAI Output Files. Answer as a practical senior SDET. Use the supplied bundle context. Do not claim to execute or patch unless QAAI tool actions do it. Keep answers specific and concise.',
            messages: [
              { role: 'user', content: buildOutputAssistantPrimer(context) },
              { role: 'assistant', content: 'I understand the generated output bundle context. What should we inspect or repair?' },
              ...priorTurns,
              { role: 'user', content: message },
            ],
          });
          reply = (resp?.content?.find?.((block) => block?.type === 'text')?.text || resp?.content?.[0]?.text || resp?.text || '').trim();
          if (!reply) {
            mode = 'deterministic_fallback';
            reply = outputAssistantFallbackReply(message, context);
          }
        }
      } catch (chatErr) {
        mode = 'provider_error_fallback';
        reply = outputAssistantFallbackReply(message, context);
      }

      await audit.log({
        userId: req.user.id,
        action: 'output.assistant.chat',
        target: project.id,
        metadata: {
          bundleId: context.bundle?.id || req.params.bundleId,
          framework: context.bundle?.framework || null,
          provider: providerName,
          mode,
          messageChars: message.length,
          replyChars: reply.length,
        },
        req,
      });

      res.json({
        success: true,
        reply,
        mode,
        context: {
          project: context.project,
          generation: context.generation,
          bundle: context.bundle,
          run: context.run,
          activeFile: context.activeFile ? {
            path: context.activeFile.path,
            kind: context.activeFile.kind,
            lineCount: context.activeFile.lineCount,
            sizeBytes: context.activeFile.sizeBytes,
            binary: context.activeFile.binary,
          } : null,
          focusedFiles: Array.isArray(context.focusedFiles)
            ? context.focusedFiles.map((file) => ({
              path: file.path,
              kind: file.kind,
              lineCount: file.lineCount,
              sizeBytes: file.sizeBytes,
              reason: file.reason,
            }))
            : [],
          files: { count: context.files?.count || 0 },
          artifacts: context.artifacts,
          validation: context.validation,
          repairJournal: context.repairJournal ? {
            repairs: Array.isArray(context.repairJournal.repairs) ? context.repairJournal.repairs.slice(-8) : [],
          } : null,
          caseContracts: context.caseContracts ? {
            count: context.caseContracts.count || 0,
            source: context.caseContracts.source || null,
            cases: Array.isArray(context.caseContracts.cases)
              ? context.caseContracts.cases.map((tc) => ({
                id: tc.id,
                name: tc.name,
                readinessStatus: tc.readinessStatus,
                runEligibility: tc.runEligibility,
                stepCount: Array.isArray(tc.steps) ? tc.steps.length : 0,
                assertionCount: Array.isArray(tc.declaredAssertions) ? tc.declaredAssertions.length : 0,
              })).slice(0, 12)
              : [],
          } : null,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// -- POST /:bundleId/assistant/patch-line ------------------------------------
// Scoped manual edit tool for the Claude-style Output Files assistant. It can
// patch one line in the selected generated bundle and journals the change, but
// it never edits QAAI source code or files outside the stored output bundle.
router.post(
  '/:bundleId/assistant/patch-line',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 20 }),
  async (req, res, next) => {
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const file = scriptValidationRunner.safeRelPath(req.body?.file);
      const line = Number(req.body?.line || 0);
      const replacement = typeof req.body?.replacementLine === 'string'
        ? req.body.replacementLine
        : (typeof req.body?.replacement === 'string' ? req.body.replacement : null);
      if (!file || !Number.isInteger(line) || line < 1 || replacement == null) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_PATCH_LINE_REQUEST',
          message: 'Provide file, line, and replacementLine for the generated output bundle.',
        });
      }

      const context = await buildOutputAssistantContext(req, project, {
        bundleId: req.params.bundleId,
        activeFilePath: file,
        message: `patch line ${line} in ${file}`,
      });
      const bundle = scriptBundleStore.readBundle({
        projectId: project.id,
        bundleId: context.bundle?.id || req.params.bundleId,
        framework: context.bundle?.framework,
      });
      const before = bundle?.files?.[file];
      if (before == null || Buffer.isBuffer(before)) {
        return res.status(404).json({
          success: false,
          code: 'SCRIPT_BUNDLE_FILE_NOT_FOUND',
          message: 'The requested generated output file was not found or is not editable text.',
        });
      }

      const beforeText = String(before);
      const lines = beforeText.split(/\r?\n/);
      if (line > lines.length) {
        return res.status(400).json({
          success: false,
          code: 'SCRIPT_PATCH_LINE_OUT_OF_RANGE',
          message: `Line ${line} is outside ${file}, which has ${lines.length} lines.`,
        });
      }
      const beforeLine = lines[line - 1] || '';
      if (req.body?.expectedBeforeLine != null && String(req.body.expectedBeforeLine) !== beforeLine) {
        return res.status(409).json({
          success: false,
          code: 'SCRIPT_REPAIR_STALE_LINE',
          message: 'The target line changed before the assistant patch was applied. Refresh and try again.',
          file,
          line,
          currentLine: beforeLine,
        });
      }

      lines[line - 1] = replacement;
      const after = lines.join('\n');
      const patched = scriptBundleStore.patchBundleFile({
        projectId: project.id,
        bundleId: context.bundle?.id || req.params.bundleId,
        framework: context.bundle?.framework,
        file,
        line,
        after,
        expectedBefore: beforeText,
        reason: 'assistant requested line patch',
        repairedBy: 'qaai_output_assistant',
        failure: null,
      });

      await audit.log({
        userId: req.user.id,
        action: 'output.assistant.patch_line',
        target: project.id,
        metadata: {
          bundleId: context.bundle?.id || req.params.bundleId,
          framework: context.bundle?.framework || null,
          file,
          line,
          repairId: patched.repair?.id || null,
        },
        req,
      });

      res.json({
        success: true,
        bundleId: context.bundle?.id || req.params.bundleId,
        framework: context.bundle?.framework || null,
        file,
        line,
        beforeLine,
        afterLine: replacement,
        repair: patched.repair,
        journal: patched.journal,
      });
    } catch (err) {
      next(err);
    }
  },
);

// -- POST /:bundleId/assistant/create-file ----------------------------------
// Create a new generated output file inside the selected bundle. This is used
// when export was blocked before a spec file existed, but QAAI still has the
// saved TestCase contract/steps/oracles in the DB.
router.post(
  '/:bundleId/assistant/create-file',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 12 }),
  async (req, res, next) => {
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const instruction = String(req.body?.instruction || req.body?.message || '').trim();
      const requestedFile = scriptValidationRunner.safeRelPath(req.body?.file);
      const replacement = typeof req.body?.content === 'string'
        ? req.body.content
        : (typeof req.body?.replacement === 'string' ? req.body.replacement : null);
      const testCaseId = String(req.body?.testCaseId || '').trim();
      const overwrite = req.body?.overwrite === true;

      const context = await buildOutputAssistantContext(req, project, {
        bundleId: req.params.bundleId,
        activeFilePath: requestedFile,
        message: instruction || 'create generated script',
      });
      const bundleId = context.bundle?.id || req.params.bundleId;
      const framework = context.bundle?.framework;
      const cases = Array.isArray(context.caseContracts?.cases) ? context.caseContracts.cases : [];
      const scenarioCase = (testCaseId ? cases.find((c) => c.id === testCaseId) : null) || cases[0] || null;
      if (!scenarioCase) {
        return res.status(409).json({
          success: false,
          code: 'SCRIPT_CREATE_NO_CASE_CONTRACT',
          message: 'No saved QAAI test case contract is available for this bundle. Run or select a generated case first.',
        });
      }

      let created = null;
      if (replacement != null) {
        if (!replacement.trim() || replacement.length > 300000) {
          return res.status(400).json({
            success: false,
            code: 'SCRIPT_CREATE_INVALID_CONTENT',
            message: 'Created file content must be non-empty and under 300,000 characters.',
          });
        }
        created = {
          file: requestedFile || defaultScriptPathForFramework(framework, scenarioCase),
          content: replacement,
          reason: instruction || 'assistant created generated output file from supplied content',
          repairedBy: 'qaai_output_assistant_create_file',
        };
      } else {
        created = await tryProviderGeneratedFileCreate({
          req,
          project,
          context,
          scenarioCase,
          requestedFile,
          instruction,
        });
        if (!created) {
          created = {
            file: requestedFile || defaultScriptPathForFramework(framework, scenarioCase),
            content: deterministicPlaywrightSpecFromContract({ scenarioCase, project: context.project, framework }),
            reason: 'QAAI created a preview script from the saved TestCase contract because provider create-file output was unavailable.',
            repairedBy: 'qaai_output_assistant_contract_fallback',
          };
        }
      }

      const file = scriptValidationRunner.safeRelPath(created.file || requestedFile || defaultScriptPathForFramework(framework, scenarioCase));
      if (!file) {
        return res.status(400).json({ success: false, code: 'SCRIPT_CREATE_FILE_DENIED', message: 'Generated file path is not safe.' });
      }
      const patched = scriptBundleStore.createBundleFile({
        projectId: project.id,
        bundleId,
        framework,
        file,
        content: created.content,
        reason: created.reason || instruction || 'assistant created generated output file',
        repairedBy: created.repairedBy || 'qaai_output_assistant_create_file',
        overwrite,
      });

      const lineCount = String(created.content || '').split(/\r?\n/).length;
      await audit.log({
        userId: req.user.id,
        action: 'output.assistant.create_file',
        target: project.id,
        metadata: {
          bundleId,
          framework: framework || null,
          file,
          lineCount,
          testCaseId: scenarioCase.id || null,
          repairId: patched.repair?.id || null,
          repairedBy: created.repairedBy || null,
        },
        req,
      });

      res.json({
        success: true,
        action: 'created',
        bundleId,
        framework: framework || null,
        file,
        line: null,
        lineCount,
        testCaseId: scenarioCase.id || null,
        repair: patched.repair,
        journal: patched.journal,
      });
    } catch (err) {
      if (err.code === 'SCRIPT_BUNDLE_FILE_EXISTS') {
        return res.status(409).json({
          success: false,
          code: err.code,
          message: 'That generated output file already exists. Rewrite it or pass overwrite=true.',
        });
      }
      if (err.code && /^SCRIPT_/.test(err.code)) {
        return res.status(400).json({ success: false, code: err.code, message: err.message });
      }
      next(err);
    }
  },
);

// -- POST /:bundleId/assistant/rewrite-file ----------------------------------
// Scoped full-file rewrite tool for the Output Files assistant. It can apply a
// user-supplied replacement or ask the configured provider to rewrite one
// generated bundle file using the QAAI writer/healer guides.
router.post(
  '/:bundleId/assistant/rewrite-file',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 12 }),
  async (req, res, next) => {
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const requestedFile = scriptValidationRunner.safeRelPath(req.body?.file || req.body?.activeFilePath);
      const instruction = String(req.body?.instruction || req.body?.message || '').trim();
      const replacement = typeof req.body?.replacement === 'string'
        ? req.body.replacement
        : (typeof req.body?.after === 'string' ? req.body.after : null);
      if (!requestedFile) {
        return res.status(400).json({
          success: false,
          code: 'SCRIPT_REWRITE_FILE_REQUIRED',
          message: 'Select or provide one generated output file to rewrite.',
        });
      }

      const context = await buildOutputAssistantContext(req, project, {
        bundleId: req.params.bundleId,
        activeFilePath: requestedFile,
        message: instruction || `rewrite ${requestedFile}`,
      });
      const bundleId = context.bundle?.id || req.params.bundleId;
      const framework = context.bundle?.framework;
      const bundle = scriptBundleStore.readBundle({
        projectId: project.id,
        bundleId,
        framework,
      });
      const before = bundle?.files?.[requestedFile];
      if (before == null || Buffer.isBuffer(before)) {
        return res.status(404).json({
          success: false,
          code: 'SCRIPT_BUNDLE_FILE_NOT_FOUND',
          message: 'The requested generated output file was not found or is not editable text.',
        });
      }

      const beforeText = String(before);
      if (req.body?.expectedBefore != null && String(req.body.expectedBefore) !== beforeText) {
        return res.status(409).json({
          success: false,
          code: 'SCRIPT_REWRITE_STALE_FILE',
          message: 'The target file changed before the assistant rewrite was applied. Refresh and try again.',
          file: requestedFile,
        });
      }

      let after = replacement;
      let reason = instruction || 'assistant requested full-file rewrite';
      let repairedBy = 'qaai_output_assistant_full_file_rewrite';
      if (after != null && (typeof after !== 'string' || !after.trim())) {
        return res.status(400).json({
          success: false,
          code: 'SCRIPT_REWRITE_EMPTY_REPLACEMENT',
          message: 'Replacement file content cannot be empty.',
        });
      }
      if (after != null && after.length > 300000) {
        return res.status(400).json({
          success: false,
          code: 'SCRIPT_REWRITE_TOO_LARGE',
          message: 'Replacement file content is too large for an in-chat rewrite.',
        });
      }

      if (after == null) {
        const proposal = await tryProviderFullFileRewrite({
          req,
          project,
          file: requestedFile,
          fileContent: beforeText,
          instruction,
          context,
        });
        if (!proposal || proposal.status !== 'rewritten') {
          return res.status(409).json({
            success: false,
            code: 'SCRIPT_REWRITE_MANUAL_GATE',
            message: 'QAAI could not safely rewrite this generated file from the available context. Paste a replacement file body or run scripts for exact failure evidence.',
          });
        }
        after = proposal.after;
        reason = proposal.reason;
        repairedBy = proposal.repairedBy;
      }

      const patched = scriptBundleStore.patchBundleFile({
        projectId: project.id,
        bundleId,
        framework,
        file: requestedFile,
        line: null,
        after,
        expectedBefore: beforeText,
        reason,
        repairedBy,
        failure: null,
      });

      const beforeLineCount = beforeText.split(/\r?\n/).length;
      const afterLineCount = String(after).split(/\r?\n/).length;
      await audit.log({
        userId: req.user.id,
        action: 'output.assistant.rewrite_file',
        target: project.id,
        metadata: {
          bundleId,
          framework: framework || null,
          file: requestedFile,
          beforeLineCount,
          afterLineCount,
          repairId: patched.repair?.id || null,
          repairedBy,
        },
        req,
      });

      res.json({
        success: true,
        bundleId,
        framework: framework || null,
        file: requestedFile,
        beforeLineCount,
        afterLineCount,
        repair: patched.repair,
        journal: patched.journal,
      });
    } catch (err) {
      next(err);
    }
  },
);

// -- POST /:bundleId/repairs/:failureId/propose -----------------------------
// Preview a generated-file repair before applying it. The proposal is computed
// from the latest script validation failure and stored output bundle snapshot.
router.post('/:bundleId/repairs/:failureId/propose', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const bundleId = String(req.params.bundleId || '').trim();
    const failureId = String(req.params.failureId || '').trim();
    const runIdFromBundle = bundleId && !['latest', LEGACY_RUN_ID].includes(bundleId) ? bundleId : null;
    const runReq = {
      ...req,
      query: {
        ...(req.query || {}),
        source: REPLAYIR_SOURCE,
        ...(runIdFromBundle && !req.query?.runId ? { runId: runIdFromBundle } : {}),
      },
    };

    const workspace = await buildReplayWorkspace(runReq, project, { validate: true });
    if (workspace.result.allBlocked) {
      return res.status(409).json({
        success: false,
        code: 'NO_EXECUTABLE_BUNDLE',
        message: 'This output bundle has no executable script package to repair yet.',
      });
    }
    const effectiveBundleId = workspace.result.runId || bundleId || 'latest';
    const storedBundle = scriptBundleStore.ensureBundle({
      projectId: project.id,
      bundleId: effectiveBundleId,
      framework: workspace.framework,
      files: workspace.files || {},
      manifest: workspace.result.manifest || null,
    });
    const latestReport = scriptValidationRunner.readLatestValidationReport({
      projectId: project.id,
      bundleId: effectiveBundleId,
    });
    const failure = scriptBundleStore.findFailure(latestReport, failureId);
    if (!failure) {
      return res.status(404).json({
        success: false,
        code: 'SCRIPT_FAILURE_NOT_FOUND',
        message: 'No matching script validation failure exists for this bundle. Run scripts first, then repair a listed failure.',
      });
    }

    let proposal = scriptRepairAgent.proposeRepair({
      files: storedBundle.files || {},
      failure,
      patch: {
        file: req.body?.file,
        after: typeof req.body?.after === 'string' ? req.body.after : null,
        expectedBefore: typeof req.body?.expectedBefore === 'string' ? req.body.expectedBefore : null,
      },
    });
    if ((!proposal || proposal.status !== 'patched') && !scriptRepairAgent.isLocatorFailure(failure)) {
      const context = await buildOutputAssistantContext(runReq, project, {
        bundleId: effectiveBundleId,
        activeFilePath: failure.file,
        message: `repair script validation failure ${failure.file}:${failure.line || 1}`,
      });
      const providerProposal = await tryProviderScriptRepairProposal({
        req,
        project,
        failure,
        storedBundle,
        context,
      });
      if (providerProposal?.status === 'patched') proposal = providerProposal;
    }
    if (!proposal || proposal.status !== 'patched') {
      return res.json({
        success: true,
        source: REPLAYIR_SOURCE,
        framework: workspace.framework,
        runId: workspace.result.runId || null,
        bundleId: effectiveBundleId,
        applied: false,
        proposal: {
          status: 'unresolved_non_blocking',
          file: failure.file || null,
          line: failure.line || null,
          reason: proposal?.reason || 'no_verified_repair_available',
          nonBlocking: true,
          message: 'No verified automatic repair was available. The generated output remains available and unchanged.',
        },
        failure,
      });
    }

    const payload = repairProposalPayload({
      proposal,
      failure,
      effectiveBundleId,
      framework: workspace.framework,
    });

    await audit.log({
      userId: req.user.id,
      action: 'output.scripts.repair.propose',
      target: project.id,
      metadata: {
        runId: workspace.result.runId || null,
        bundleId: effectiveBundleId,
        failureId,
        file: payload.file,
        line: payload.line,
        reason: payload.reason,
      },
      req,
    });

    return res.json({
      success: true,
      source: REPLAYIR_SOURCE,
      framework: workspace.framework,
      runId: workspace.result.runId || null,
      bundleId: effectiveBundleId,
      proposal: payload,
    });
  } catch (err) {
    if (err.code && /^SCRIPT_/.test(err.code)) {
      return res.status(400).json({ success: false, code: err.code, message: err.message });
    }
    next(err);
  }
});

// -- POST /:bundleId/repairs/:failureId/apply -------------------------------
// Phase 6: patch a failed generated-script line inside the persistent output
// bundle, journal the repair, then rerun only the failed test.
router.post('/:bundleId/repairs/:failureId/apply', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const bundleId = String(req.params.bundleId || '').trim();
    const failureId = String(req.params.failureId || '').trim();
    const runIdFromBundle = bundleId && !['latest', LEGACY_RUN_ID].includes(bundleId) ? bundleId : null;
    const runReq = {
      ...req,
      query: {
        ...(req.query || {}),
        source: REPLAYIR_SOURCE,
        ...(runIdFromBundle && !req.query?.runId ? { runId: runIdFromBundle } : {}),
      },
    };

    const workspace = await buildReplayWorkspace(runReq, project, { validate: true });
    if (workspace.result.allBlocked) {
      return res.status(409).json({
        success: false,
        code: 'NO_EXECUTABLE_BUNDLE',
        message: 'This output bundle has no executable script package to repair yet.',
      });
    }
    const effectiveBundleId = workspace.result.runId || bundleId || 'latest';
    const storedBundle = scriptBundleStore.ensureBundle({
      projectId: project.id,
      bundleId: effectiveBundleId,
      framework: workspace.framework,
      files: workspace.files || {},
      manifest: workspace.result.manifest || null,
    });
    const latestReport = scriptValidationRunner.readLatestValidationReport({
      projectId: project.id,
      bundleId: effectiveBundleId,
    });
    const failure = scriptBundleStore.findFailure(latestReport, failureId);
    if (!failure) {
      return res.status(404).json({
        success: false,
        code: 'SCRIPT_FAILURE_NOT_FOUND',
        message: 'No matching script validation failure exists for this bundle. Run scripts first, then repair a listed failure.',
      });
    }

    const proposal = scriptRepairAgent.proposeRepair({
      files: storedBundle.files || {},
      failure,
      patch: {
        file: req.body?.file,
        after: typeof req.body?.after === 'string' ? req.body.after : null,
        expectedBefore: typeof req.body?.expectedBefore === 'string' ? req.body.expectedBefore : null,
      },
    });
    if (!proposal || proposal.status !== 'patched') {
      return res.json({
        success: true,
        source: REPLAYIR_SOURCE,
        framework: workspace.framework,
        runId: workspace.result.runId || null,
        bundleId: effectiveBundleId,
        applied: false,
        repair: {
          status: 'unresolved_non_blocking',
          file: failure.file || null,
          line: failure.line || null,
          reason: proposal?.reason || 'no_verified_repair_available',
          nonBlocking: true,
          message: 'No verified in-place repair was available. The generated output remains available and unchanged.',
        },
        failure,
      });
    }

    const patched = scriptBundleStore.patchBundleFile({
      projectId: project.id,
      bundleId: effectiveBundleId,
      framework: workspace.framework,
      file: proposal.file || failure.file,
      line: failure.line,
      after: proposal.after,
      expectedBefore: proposal.before,
      reason: proposal.reason,
      repairedBy: proposal.repairedBy,
      failure,
    });

    const rerun = await scriptValidationRunner.runScriptValidation({
      projectId: project.id,
      bundleId: effectiveBundleId,
      framework: workspace.framework,
      files: patched.bundle.files || {},
      mode: 'repair_rerun',
      testFile: failure.file,
      testTitle: failure.testTitle,
    });
    if (patched.journal?.repairs?.length) rerun.repairJournal = patched.journal;

    await audit.log({
      userId: req.user.id,
      action: 'output.scripts.repair',
      target: project.id,
      metadata: {
        runId: workspace.result.runId || null,
        bundleId: effectiveBundleId,
        failureId,
        file: patched.repair.file,
        line: patched.repair.line,
        repairId: patched.repair.id,
        rerunStatus: rerun.status,
      },
      req,
    });

    const send = req.app.locals.broadcastToUser;
    if (send) {
      send(req.user.id, {
        type: 'output.scriptRepairComplete',
        projectId: project.id,
        runId: workspace.result.runId || null,
        bundleId: effectiveBundleId,
        failureId,
        repair: patched.repair,
        status: rerun.status,
        summary: rerun.summary,
      });
    }

    return res.json({
      success: true,
      source: REPLAYIR_SOURCE,
      framework: workspace.framework,
      runId: workspace.result.runId || null,
      bundleId: effectiveBundleId,
      repair: patched.repair,
      job: rerun,
    });
  } catch (err) {
    if (err.code === 'SCRIPT_REPAIR_STALE_FILE') {
      return res.status(409).json({
        success: false,
        code: err.code,
        message: 'The stored output file changed after validation. Re-run scripts and apply repair again.',
      });
    }
    if (err.code && /^SCRIPT_/.test(err.code)) {
      return res.status(400).json({ success: false, code: err.code, message: err.message });
    }
    next(err);
  }
});

function serialiseRun(r) {
  if (!r) return null;
  return {
    id: r.id,
    sprintId: r.sprintId,
    sprintName: r.sprintName,
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    latestResultAt: r.latestResultAt || null,
    lastActivityAt: r.lastActivityAt || r.completedAt || r.startedAt || null,
    outputEvidence: r.outputEvidence || null,
    summary: {
      passed: r.passed ?? 0,
      failed: r.failed ?? 0,
      blocked: r.blocked ?? 0,
      skipped: r.skipped ?? 0,
    },
  };
}

// ── Single file viewer ────────────────────────────────────
// GET /api/projects/:projectId/output-files/file/<rel/path/to/file>
//
// Rejects path-escape attempts. Restricts to the playwright workspace.
router.get('/file/*', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const rel = req.params[0] || '';
    if (!rel || rel.includes('..')) {
      return res.status(400).json({ success: false, code: 'PATH_DENIED' });
    }
    if (wantsReplayIr(req)) {
      const workspace = await buildReplayWorkspace(req, project, { validate: false });
      // File reads are allowed even when exportValid=false (user can inspect what was generated).
      // Readiness/certification metadata never hides files; only a real secret leak is refused.
      const normalised = rel.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!Object.prototype.hasOwnProperty.call(workspace.files, normalised)) {
        return res.status(404).json({ success: false, code: 'NOT_FOUND' });
      }
      const rawContent = workspace.files[normalised];
      const isBinary = Buffer.isBuffer(rawContent) || /\.xlsx$/i.test(normalised);
      const sizeBytes = Buffer.isBuffer(rawContent) ? rawContent.length : Buffer.byteLength(String(rawContent || ''), 'utf8');
      if (isBinary) {
        return res.json({
          success: true,
          source: REPLAYIR_SOURCE,
          framework: workspace.framework,
          name: path.basename(normalised),
          path: normalised,
          sizeBytes,
          mtime: new Date(),
          kind: classifyFile(normalised),
          binary: true,
          content: '',
          message: 'Binary workbook preview is not shown inline. Use ZIP download or Open in VS Code to open this file in Excel.',
        });
      }
      const content = String(rawContent || '');
      const MAX = 1_500_000;
      if (sizeBytes > MAX) {
        return res.status(413).json({
          success: false,
          code: 'TOO_LARGE',
          message: `File is ${(sizeBytes / 1024).toFixed(0)} KB - too large to preview inline. Use the ZIP download.`,
        });
      }
      return res.json({
        success: true,
        source: REPLAYIR_SOURCE,
        framework: workspace.framework,
        name: path.basename(normalised),
        path: normalised,
        sizeBytes,
        mtime: new Date(),
        kind: classifyFile(normalised),
        content,
      });
    }
    const { run, runDir } = await resolveTargetRun(req, project);
    if (!run || !runDir) {
      return res.status(404).json({ success: false, code: 'NO_RUN', message: 'No run output workspace exists yet.' });
    }
    const full = path.join(runDir, rel);
    if (!full.startsWith(runDir)) {
      return res.status(400).json({ success: false, code: 'PATH_ESCAPE' });
    }
    if (!fs.existsSync(full)) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    }
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      return res.status(400).json({ success: false, code: 'IS_DIR', message: 'Path resolves to a directory, not a file.' });
    }
    // Reject huge binaries — clients can use the ZIP download for those.
    const MAX = 1_500_000; // 1.5 MB
    if (st.size > MAX) {
      return res.status(413).json({
        success: false,
        code: 'TOO_LARGE',
        message: `File is ${(st.size / 1024).toFixed(0)} KB — too large to preview inline. Use the ZIP download.`,
      });
    }
    const content = fs.readFileSync(full, 'utf8');
    res.json({
      success: true,
      name: path.basename(rel),
      path: rel,
      sizeBytes: st.size,
      mtime: st.mtime,
      kind: classifyFile(rel),
      content,
    });
  } catch (err) {
    next(err);
  }
});

// ── Download zip ──────────────────────────────────────────
// Bundles the entire playwright workspace into a downloadable zip.
router.get('/download.zip', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const enterpriseOn = await enterpriseMode.readProjectEnterpriseMode(prisma, project.id, project);

    // ── Enterprise Mode P9 — ReplayIR is now the DEFAULT export path. ──────────
    // Compiles a framework package ONLY from each RunResult's pinned replayIrJson.
    // Explicit ?source=legacy opts into the old workspace-file path.
    // Hard-refuses only a real secret leak; incomplete/unverified output remains downloadable.
    if (req.query.source !== 'legacy') {
      let framework;
      try {
        framework = replayFramework(req, project);
      } catch (e) {
        if (e.code === 'UNSUPPORTED_REPLAY_FRAMEWORK') {
          return res.status(400).json({ success: false, code: 'UNSUPPORTED_REPLAY_FRAMEWORK', message: e.message });
        }
        throw e;
      }
      const reqRunId = typeof req.query.runId === 'string' && req.query.runId.trim() && req.query.runId.trim() !== LEGACY_RUN_ID ? req.query.runId.trim() : null;
      const runResultIds = typeof req.query.runResultIds === 'string' && req.query.runResultIds.trim()
        ? req.query.runResultIds.split(',').map((s) => s.trim()).filter(Boolean) : null;
      const generationId = reqRunId || (Array.isArray(runResultIds) && runResultIds.length)
        ? null
        : await resolveRequestedGenerationId(req, project);

      let result;
      try {
        result = await replayExport.buildReplayExport({
          projectId: project.id,
          runId: reqRunId,
          runResultIds,
          generationId,
          framework,
          validate: false,
        });
      } catch (e) {
        if (e.code === 'UNKNOWN_FRAMEWORK') return res.status(400).json({ success: false, code: 'UNKNOWN_FRAMEWORK', message: e.message });
        throw e;
      }

      await audit.log({ userId: req.user.id, action: 'output.export.replayir', target: project.id, metadata: { runId: result.runId, framework, admitted: result.admitted.length, blocked: result.blocked.length, allBlocked: result.allBlocked }, req });

      // Readiness, certification, and secret-scan findings are diagnostic.
      // They remain in the package manifest but never suppress user access.
      // exportValid=false is informational — the ZIP is still served so users can inspect generated code.

      if (enterpriseOn) {
        const assessment = enterpriseMode.assessReplayExport({ project, result, framework });
        if (!assessment.ok) {
          await audit.log({
            userId: req.user.id,
            action: 'output.export.enterprise.blocked',
            target: project.id,
            metadata: { runId: result.runId, framework, findings: assessment.findings.map((f) => f.rule) },
            req,
          });
        }
        result.manifest.enterprise = {
          ...(assessment.evidence || {}),
          ok: assessment.ok,
          diagnosticsOnly: true,
          findings: assessment.findings || [],
        };
        result.files['EXPORT_MANIFEST.json'] = JSON.stringify(result.manifest, null, 2) + '\n';
        await audit.log({
          userId: req.user.id,
          action: 'output.export.enterprise.approved',
          target: project.id,
          metadata: { runId: result.runId, framework, admitted: result.admitted.length, parityReport: assessment.evidence.parityReport },
          req,
        });
      }

      // ── CERTIFICATION_REPORT.json ─────────────────────────────────────────
      // Inject a machine-readable certification proof into the ZIP so the
      // exported package carries its own lineage without needing DB access.
      // Only added when ExportCertification rows exist for this run; silently
      // skipped otherwise (legacy runs, mid-pipeline runs).
      try {
        const certRows = result.runId ? await prisma.exportCertification.findMany({
          where: { runId: result.runId },
          select: {
            id: true, framework: true, journeySlug: true, status: true,
            parityMatched: true, mcpVerdict: true, runnerVerdict: true,
            kbMissCount: true, repairRound: true, certifiedAt: true,
            irHash: true, actionJournalHash: true, packageHash: true,
            pipelineTraceId: true, createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        }) : [];
        if (certRows.length) {
          const total = certRows.length;
          const certCount = certRows.filter((r) => r.status === 'certified').length;
          const certReport = {
            qaaiVersion: 'certification-pipeline-v1',
            generatedAt: new Date().toISOString(),
            runId: result.runId,
            projectId: project.id,
            framework,
            summary: {
              total,
              certified: certCount,
              draft: certRows.filter((r) => r.status === 'draft').length,
              incompleteEvidence: certRows.filter((r) => r.status === 'incomplete_evidence').length,
              notExportable: certRows.filter((r) => r.status === 'not_exportable').length,
              allCertified: total > 0 && certCount === total,
            },
            journeys: certRows.map((r) => ({
              journeySlug: r.journeySlug,
              status: r.status,
              parityMatched: r.parityMatched,
              mcpVerdict: r.mcpVerdict,
              runnerVerdict: r.runnerVerdict,
              kbMissCount: r.kbMissCount,
              repairRound: r.repairRound,
              irHash: r.irHash,
              actionJournalHash: r.actionJournalHash,
              packageHash: r.packageHash,
              pipelineTraceId: r.pipelineTraceId,
              certifiedAt: r.certifiedAt,
            })),
          };
          result.files['CERTIFICATION_REPORT.json'] = JSON.stringify(certReport, null, 2) + '\n';
        }
      } catch (_) {}
      // ─────────────────────────────────────────────────────────────────────

      const safeName = project.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'qaai-project';
      const zipName = `${safeName}-replayir-${framework}-${String(result.runId || 'run').slice(0, 8)}.zip`;
      const zip = new ZipWriter();
      for (const [rel, content] of Object.entries(result.files)) zip.addFile(rel, bufferFromExportContent(content));
      const out = zip.toBuffer();
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
      res.setHeader('X-QAAI-Export-Valid', String(result.manifest.exportValid !== false));
      res.setHeader('Content-Length', String(out.length));
      return res.end(out);
    }

    if (enterpriseOn) {
      await audit.log({
        userId: req.user.id,
        action: 'output.export.enterprise.legacy_blocked',
        target: project.id,
        metadata: { source: req.query.source || null },
        req,
      });
      return res.status(409).json({
        success: false,
        code: 'ENTERPRISE_REQUIRES_REPLAYIR',
        message: 'Enterprise Mode requires ReplayIR export with package validation and P8 execution-parity evidence. Use source=replayir.',
      });
    }

    const { run, runDir } = await resolveTargetRun(req, project);
    if (!run || !runDir || !fs.existsSync(runDir)) {
      return res.status(404).json({ success: false, code: 'NO_RUN_OUTPUT', message: 'No output workspace exists for this run yet.' });
    }

    const safeProjectName = project.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'qaai-project';
    const runStamp = run.startedAt ? new Date(run.startedAt).toISOString().slice(0, 10) : 'run';
    const zipName = `${safeProjectName}-${runStamp}-${run.id.slice(0, 8)}.zip`;

    const files = collectProjectFiles(project, run, runDir);
    const zip = new ZipWriter();
    for (const { rel, buf } of files) zip.addFile(rel, buf);

    await audit.log({
      userId: req.user.id,
      action: 'output.download',
      target: project.id,
      metadata: { runId: run.id, fileCount: files.length },
      req,
    });

    const out = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.setHeader('Content-Length', String(out.length));
    res.end(out);
  } catch (err) {
    next(err);
  }
});

// ── Live-replay direct export (2026-08-05) ────────────────
// Generates real, runnable Playwright code straight from a RunResult's
// stepResults evidence (see server/services/codegen/liveReplayCodegen.js).
// This exists because the legacy ReplayIR path (download.zip above) only
// recognizes the OLD conductor's actionTrail schema and rejects the current
// controller's evidence as "zero execution provenance" even on a fully
// passing live run — see PHASE_LOG 2026-08-05. Every rendered line is either
// an independently re-verified Playwright locator or a deterministic
// literal extracted from the authored assertion text; anything else is a
// visible diagnostic comment, never fabricated. Runs strictly at
// export/download time against already-persisted RunResult rows — it
// cannot affect or slow a live run.
router.get('/live-replay.zip', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const runId = typeof req.query.runId === 'string' ? req.query.runId.trim() : '';
    if (!runId) return res.status(400).json({ success: false, code: 'RUN_ID_REQUIRED', message: 'runId query parameter is required.' });
    const result = await liveReplayCodegen.buildLiveReplayPackage({ projectId: project.id, runId });
    const zip = new ZipWriter();
    for (const [rel, content] of Object.entries(result.files)) {
      zip.addFile(rel, Buffer.from(content, 'utf8'));
    }
    const out = zip.toBuffer();
    await audit.log({
      userId: req.user.id,
      action: 'output.liveReplay.download',
      target: project.id,
      metadata: { runId, admitted: result.admitted.length, blocked: result.blocked.length },
      req,
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="qaai-live-replay-${runId}.zip"`);
    res.setHeader('Content-Length', String(out.length));
    res.end(out);
  } catch (err) {
    if (err.code === 'RUN_NOT_FOUND') {
      return res.status(404).json({ success: false, code: err.code, message: err.message });
    }
    next(err);
  }
});

// ── Enterprise evidence bundle ────────────────────────────
// One audit ZIP for the selected run: requirements/RTM, approved TestData
// mappings, auth/atlas context, ReplayIR envelopes, export manifests, and P8
// parity reports. It does not include raw TestData row values or credentials.
router.get('/evidence.zip', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const reqRunId = typeof req.query.runId === 'string' && req.query.runId.trim() && req.query.runId.trim() !== LEGACY_RUN_ID
      ? req.query.runId.trim()
      : null;
    const frameworks = evidenceBundle.parseFrameworks(req.query.frameworks || req.query.framework || 'all');
    const bundle = await evidenceBundle.buildEvidenceBundle({
      prisma,
      project,
      runId: reqRunId,
      frameworks,
      includeExportManifests: req.query.exports !== '0',
    });
    const zip = new ZipWriter();
    for (const [rel, content] of Object.entries(bundle.files)) {
      zip.addFile(rel, Buffer.from(content, 'utf8'));
    }
    const out = zip.toBuffer();
    await audit.log({
      userId: req.user.id,
      action: 'output.evidence.download',
      target: project.id,
      metadata: { runId: bundle.run.id, fileCount: bundle.fileCount, frameworks },
      req,
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${bundle.filename}"`);
    res.setHeader('Content-Length', String(out.length));
    res.end(out);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, code: err.code || 'EVIDENCE_FAILED', message: err.message });
    next(err);
  }
});

// ── Files as JSON ─────────────────────────────────────────
// Returns the run's COMPLETE project as [{ path, content }] text entries.
// Powers the browser-side "Save to folder" (File System Access API) flow —
// the frontend writes these straight into a folder the user picks, on THEIR
// machine, so it works even when QAAI is deployed remotely (no server-side
// disk write, no unzip). All generated artifacts are text; binaries (results/
// screenshots) are excluded by collectProjectFiles' dir policy.
router.get('/files.json', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    if (wantsReplayIr(req)) {
      const workspace = await buildReplayWorkspace(req, project, { validate: false });
      const files = Object.entries(workspace.files || {}).map(([rel, content]) => ({
        path: rel,
        content: Buffer.isBuffer(content) ? content.toString('base64') : String(content || ''),
        encoding: Buffer.isBuffer(content) ? 'base64' : 'utf8',
        binary: Buffer.isBuffer(content),
      }));
      await audit.log({
        userId: req.user.id,
        action: 'output.files-json.replayir',
        target: project.id,
        metadata: { runId: workspace.result.runId, framework: workspace.framework, fileCount: files.length },
        req,
      });
      return res.json({
        success: true,
        source: REPLAYIR_SOURCE,
        framework: workspace.framework,
        runId: workspace.result.runId,
        fileCount: files.length,
        manifest: workspace.result.manifest || null,
        files,
      });
    }

    const { run, runDir } = await resolveTargetRun(req, project);
    if (!run || !runDir || !fs.existsSync(runDir)) {
      return res.status(404).json({ success: false, code: 'NO_RUN_OUTPUT', message: 'No output workspace exists for this run yet.' });
    }
    const files = collectProjectFiles(project, run, runDir).map((f) => ({
      path: f.rel,
      content: f.buf.toString('utf8'),
    }));
    res.json({ success: true, runId: run.id, fileCount: files.length, files });
  } catch (err) {
    next(err);
  }
});

// ── Open in VS Code ───────────────────────────────────────
// Copies this run's complete project into the project's configured local
// folder (Project.vscodeWorkspacePath) and launches `code <folder>` so the
// exact file structure opens directly in the operator's VS Code — no zip, no
// unzip. Only meaningful when the server runs on the operator's own machine
// (current single-tenant deployment).
//
// Responses the frontend branches on:
//   200 { success:true, opened:true, path }     → VS Code launched
//   400 { code:'NO_WORKSPACE_PATH' }             → ask the user for a folder, save it, retry
//   409 { code:'NO_CODE_CLI' }                   → `code` not on PATH; fall back to ZIP / manual open
//   200 { success:true, opened:false, code:'NO_CODE_CLI', path } → files copied but couldn't launch
router.post('/open-in-vscode', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const target = (project.vscodeWorkspacePath || '').trim();
    if (!target) {
      return res.status(400).json({ success: false, code: 'NO_WORKSPACE_PATH', message: 'No VS Code workspace folder configured for this project.' });
    }
    if (!pathIsSafe(target) || !path.isAbsolute(target)) {
      return res.status(400).json({ success: false, code: 'INVALID_PATH', message: 'Workspace folder must be an absolute path with no special characters.' });
    }

    let run;
    let files;
    let source = LEGACY_SOURCE;
    let framework = null;
    if (wantsReplayIr(req)) {
      const workspace = await buildReplayWorkspace(req, project, { validate: false });
      run = workspace.run || { id: workspace.result.runId };
      files = Object.entries(workspace.files || {}).map(([rel, content]) => ({
        rel,
        buf: bufferFromExportContent(content),
      }));
      source = REPLAYIR_SOURCE;
      framework = workspace.framework;
    } else {
      const resolved = await resolveTargetRun(req, project);
      run = resolved.run;
      const runDir = resolved.runDir;
      if (!run || !runDir || !fs.existsSync(runDir)) {
        return res.status(404).json({ success: false, code: 'NO_RUN_OUTPUT', message: 'No output workspace exists for this run yet.' });
      }
      files = collectProjectFiles(project, run, runDir);
    }

    // Copy the complete project into the operator's folder. Create it if it
    // doesn't exist (the user may have just typed a fresh path).
    fs.mkdirSync(target, { recursive: true });

    // CLEAN the generated subtrees FIRST. Without this, "Open in VS Code"
    // overlaid the current run onto whatever a PREVIOUS copy left behind:
    // stale specs/page-objects from an earlier run — a different case set, a
    // different module, or pre-fix broken output — lingered with different
    // filenames and broke `npx playwright test` (duplicate-class + missing
    // semicolon errors on files this run never produced). We remove only the
    // top-level directories the generator OWNS and is about to repopulate
    // (tests/, pages/, fixtures/, utils/, features/, steps/, src/, target/ …),
    // never the whole folder and never a dot-dir (.vscode/.git) or root files,
    // so anything unrelated the user added survives. Result: the workspace is
    // always a clean, coherent, runnable copy of THIS run.
    const ownedDirs = new Set(
      files
        .map((f) => String(f.rel).replace(/\\/g, '/').split('/')[0])
        .filter((seg) => seg && !seg.startsWith('.') && !seg.includes('.')),
    );
    for (const dir of ownedDirs) {
      const full = path.join(target, dir);
      if (path.resolve(full).startsWith(path.resolve(target) + path.sep) && fs.existsSync(full)) {
        try { fs.rmSync(full, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
      }
    }

    for (const { rel, buf } of files) {
      const dest = path.join(target, rel);
      // Defense-in-depth: never let a crafted rel path escape the target dir.
      if (!path.resolve(dest).startsWith(path.resolve(target))) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
    }

    const launch = openInVsCode(target);

    await audit.log({
      userId: req.user.id,
      action: source === REPLAYIR_SOURCE ? 'output.open-in-vscode.replayir' : 'output.open-in-vscode',
      target: project.id,
      metadata: { runId: run.id, fileCount: files.length, launched: launch.ok, path: target, source, framework },
      req,
    });

    if (!launch.ok && launch.code === 'NO_CODE_CLI') {
      // Files are written; we just can't auto-launch (code CLI missing).
      return res.json({ success: true, opened: false, code: 'NO_CODE_CLI', path: target, fileCount: files.length });
    }
    if (!launch.ok) {
      return res.status(500).json({ success: false, code: launch.code || 'LAUNCH_FAILED', message: launch.message, path: target });
    }
    res.json({ success: true, opened: true, path: target, fileCount: files.length });
  } catch (err) {
    next(err);
  }
});

// Recursively yield { rel, full } for every file under `dir`, rooted at the
// given run-relative prefix. Skips dotfiles except the ones we explicitly want
// (.env.example), and never descends into heavy artifact dirs.
function* walkFiles(dir, relPrefix) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (HIDDEN_TOP.has(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    const full = path.join(dir, e.name);
    const rel = `${relPrefix}/${e.name}`;
    if (e.isDirectory()) {
      yield* walkFiles(full, rel);
    } else if (e.isFile()) {
      yield { rel, full };
    }
  }
}

// Assemble the COMPLETE project file set for a run: the on-disk source tree
// PLUS the convenience files (README, .gitignore, .env.example, .vscode/) so
// the result is an open-in-VS-Code-and-run project regardless of run age.
// Shared by the ZIP download and the "Open in VS Code" copy. Returns
// [{ rel, buf }] with POSIX-style relative paths.
function collectProjectFiles(project, run, runDir) {
  const isJs = (project.framework || '').startsWith('playwright-js');
  const out = [];
  const seen = new Set();
  const add = (rel, buf) => { out.push({ rel, buf: Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8') }); seen.add(rel); };

  for (const dir of TOP_LEVEL_DIRS) {
    const abs = path.join(runDir, dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    for (const { rel, full } of walkFiles(abs, dir)) add(rel, fs.readFileSync(full));
  }
  for (const file of TOP_LEVEL_FILES) {
    const abs = path.join(runDir, file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    // Playwright config: patch the baked baseURL fallback to the CURRENT
    // project.targetUrl regardless of what was written when the run was
    // generated (old runs may have 'demo.playwright.dev/todomvc' as the
    // fallback because targetUrl wasn't set on the project at that time).
    if ((file === 'playwright.config.ts' || file === 'playwright.config.js') && project.targetUrl) {
      const raw = fs.readFileSync(abs, 'utf8');
      const patched = raw.replace(
        /process\.env\.QAAI_TARGET_URL\s*\|\|\s*['"][^'"]*['"]/g,
        `process.env.QAAI_TARGET_URL || ${JSON.stringify(project.targetUrl)}`,
      );
      add(file, Buffer.from(patched, 'utf8'));
    } else {
      add(file, fs.readFileSync(abs));
    }
  }
  // Only ADD convenience files the run dir didn't already produce — never
  // clobber a real generated file.
  if (!seen.has('README.md')) add('README.md', readmeTemplate(project, run, isJs));
  if (!seen.has('.gitignore')) add('.gitignore', 'node_modules/\ntest-results/\nplaywright-report/\nresults/\n.env\n');
  if (!seen.has('.env.example')) add('.env.example', envExample(project));
  // Always write .env (even if one already exists) so QAAI_TARGET_URL is never
  // stale. A leftover .env from a previous project's workspace copy would win
  // over the baked-in baseURL fallback via dotenv, causing tests to hit the
  // wrong site. Credentials (TEST_EMAIL / TEST_PASSWORD) are not written here —
  // add them manually once; they survive as long as you don't delete .env.
  add('.env', envDotFile(project));
  add('.vscode/extensions.json', vscodeExtensions(project.framework));
  add('.vscode/settings.json', vscodeSettings());
  return out;
}

function decodeJsonSafe(text, fallback = null) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function isLocatorReacquisitionGap(gap) {
  if (!gap || !gap.pageUrl) return false;
  const code = String(gap.type || gap.code || gap.reason || '').toLowerCase();
  const text = [
    gap.narration,
    gap.elementLabel,
    gap.description,
    gap.detail,
    gap.where,
  ].filter(Boolean).join(' ').toLowerCase();
  return code.includes('locator') || text.includes('locator');
}

function normalizeRepairGap(gap, runResultId, gapIndex) {
  const narration = gap.narration || gap.description || gap.elementLabel || gap.detail || 'missing locator';
  const tool = gap.tool || gap.where || 'unknown';
  const elementLabel = gap.elementLabel || narration;
  return {
    ...gap,
    type: gap.type || gap.code || 'missing_action_locator_evidence',
    pageUrl: gap.pageUrl,
    narration,
    tool,
    elementLabel,
    repairable: true,
    action: {
      runResultId,
      gapIndex,
      narration,
      elementLabel,
      pageUrl: gap.pageUrl,
      tool,
    },
  };
}

function collectLocatorRepairGaps({ meta, replayIrJson, runResultId }) {
  const out = [];
  const seen = new Set();
  const push = (gap, index) => {
    if (!isLocatorReacquisitionGap(gap)) return;
    const key = [
      gap.pageUrl,
      gap.narration || gap.elementLabel || gap.description || gap.detail || '',
      gap.type || gap.code || '',
    ].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalizeRepairGap(gap, runResultId, out.length || index || 0));
  };
  for (const [index, gap] of Array.from(meta?.gaps || []).entries()) {
    if ((gap.repairable && gap.pageUrl) || isLocatorReacquisitionGap(gap)) push(gap, index);
  }
  const envelope = decodeJsonSafe(replayIrJson, null);
  for (const [index, gap] of Array.from(envelope?.gaps || []).entries()) {
    push(gap, index);
  }
  return out;
}

// ── POST /repair ─────────────────────────────────────────
// Phase D API: trigger evidence repair for RunResults in incomplete_evidence
// state. Starts a background MCP DOM-probe session to fill missing locators
// in the KB, then re-validates each result's contract.
// Body: { runId: string }
router.post('/repair', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const runId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : null;
    if (!runId || runId === LEGACY_RUN_ID) {
      return res.status(400).json({ success: false, code: 'MISSING_RUN_ID', message: 'runId required in request body.' });
    }

    const run = await prisma.run.findFirst({
      where: { id: runId, projectId: project.id },
      select: { id: true },
    });
    if (!run) return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Run not found.' });

    const results = await prisma.runResult.findMany({
      where: { runId },
      select: { id: true, exportMeta: true, replayIrJson: true },
    });

    const maxRepairRounds = outputRepairMaxRounds();
    const repairTargets = [];
    const exhaustedTargets = [];
    for (const r of results) {
      if (!r.exportMeta) continue;
      let meta;
      try { meta = JSON.parse(r.exportMeta); } catch (_) { continue; }
      if (!['incomplete_evidence', 'not_exportable'].includes(meta.state)) continue;
      if (Number(meta.repairRound || 0) >= maxRepairRounds) {
        meta.state = 'not_exportable';
        meta.reason = 'repair_budget_exhausted';
        meta.retryLimit = maxRepairRounds;
        meta.repairBudgetExhaustedAt = new Date().toISOString();
        meta.handoff = 'reacquisition_required';
        try {
          await prisma.runResult.update({ where: { id: r.id }, data: { exportMeta: JSON.stringify(meta) } });
        } catch (_) {}
        exhaustedTargets.push(r.id);
        continue;
      }
      const repairableGaps = collectLocatorRepairGaps({ meta, replayIrJson: r.replayIrJson, runResultId: r.id });
      if (repairableGaps.length) repairTargets.push({ id: r.id, meta, replayIrJson: r.replayIrJson || null, repairableGaps });
    }

    if (!repairTargets.length) {
      return res.status(409).json({
        success: false,
        code: exhaustedTargets.length ? 'REPAIR_BUDGET_EXHAUSTED' : 'NOTHING_TO_REPAIR',
        message: exhaustedTargets.length
          ? `Output repair retry budget exhausted for ${exhaustedTargets.length} result(s). QAAI must reacquire those steps in a fresh run instead of repeating the same repair path.`
          : 'No RunResults with locator evidence gaps are available for reacquisition.',
        retryLimit: maxRepairRounds,
        exhaustedCount: exhaustedTargets.length,
      });
    }

    // Mark all targets as repairing before returning 202
    const now = new Date().toISOString();
    for (const rt of repairTargets) {
      rt.meta.state = 'repairing';
      rt.meta.repairStartedAt = now;
      try {
        await prisma.runResult.update({ where: { id: rt.id }, data: { exportMeta: JSON.stringify(rt.meta) } });
      } catch (_) {}
    }

    const userId = req.user.id;
    const projectId = project.id;
    const broadcastToUser = req.app.locals.broadcastToUser;
    const send = (msg) => broadcastToUser && broadcastToUser(userId, { ...msg, projectId });

    res.status(202).json({
      success: true,
      message: `Evidence repair started for ${repairTargets.length} result(s). The page will refresh when complete.`,
      targetCount: repairTargets.length,
      retryLimit: maxRepairRounds,
      exhaustedCount: exhaustedTargets.length,
    });

    // Background DOM-probe repair — runs after response is sent
    setImmediate(async () => {
      const mcp = require('../services/mcp');
      const evidenceRepair = require('../services/agents/evidenceRepair');
      let mcpSession = null;
      try {
        mcpSession = await mcp.startMcpSession({
          userId,
          targetUrl: project.targetUrl || '',
          broadcast: send,
          project,
        });
        mcpSession.callTool = (name, args) => mcp.callTool(mcpSession, name, args || {});

        // Flatten all repairable gaps with their action descriptors
        const allGaps = repairTargets.flatMap((rt) =>
          rt.repairableGaps.map((g, gapIndex) => ({
            type: g.type,
            pageUrl: g.pageUrl,
            narration: g.narration || g.description || '',
            elementLabel: g.elementLabel || null,
            action: {
              runResultId: rt.id,
              gapIndex,
              narration: g.narration || g.description || '',
              elementLabel: g.elementLabel || null,
              pageUrl: g.pageUrl,
              tool: g.tool || 'unknown',
            },
          }))
        );

        const { resolved, failed, repairSummary } = await evidenceRepair.repairEvidence({
          repairableGaps: allGaps,
          projectId,
          runId,
          mcp: mcpSession,
          send,
          prisma,
        });

        const resolvedByResultId = new Map();
        for (const item of resolved) {
          const id = item && item.action && item.action.runResultId;
          if (!id) continue;
          if (!resolvedByResultId.has(id)) resolvedByResultId.set(id, []);
          resolvedByResultId.get(id).push(item);
        }
        const failedByResultId = new Map();
        for (const item of failed) {
          const id = item && item.action && item.action.runResultId;
          if (!id) continue;
          if (!failedByResultId.has(id)) failedByResultId.set(id, []);
          failedByResultId.get(id).push(item);
        }

        // Update each result based on whether its gaps were resolved
        for (const rt of repairTargets) {
          const resultResolved = resolvedByResultId.get(rt.id) || [];
          const resultFailed = failedByResultId.get(rt.id) || [];
          let patchedReplay = null;
          let patchResult = { changed: false, patchedKeys: [] };
          if (rt.replayIrJson && resultResolved.length) {
            try {
              const envelope = JSON.parse(rt.replayIrJson);
              patchResult = evidenceRepair.patchReplayIrEnvelope({ envelope, resolved: resultResolved });
              if (patchResult && patchResult.changed && patchResult.envelope) {
                patchedReplay = JSON.stringify(patchResult.envelope);
              }
            } catch (_) {
              patchResult = { changed: false, patchedKeys: [] };
            }
          }
          const patchedGapIndexes = new Set((patchResult.patchedKeys || [])
            .filter((item) => item && item.runResultId === rt.id && item.gapIndex != null)
            .map((item) => Number(item.gapIndex)));
          const remainingGaps = rt.repairableGaps.filter((g, index) => {
            if (patchedGapIndexes.has(index)) return false;
            const narration = g.narration || g.description || '';
            return !resultResolved.some((item) => {
              const itemNarration = item && item.action && item.action.narration || '';
              return itemNarration && itemNarration === narration && patchedReplay;
            });
          });
          const replayEnvelope = patchedReplay
            ? (() => { try { return JSON.parse(patchedReplay); } catch (_) { return null; } })()
            : null;
          const replayReady = !rt.replayIrJson || !!(replayEnvelope && replayEnvelope.complete !== false);
          rt.meta.state = remainingGaps.length === 0 && replayReady ? 'draft' : 'incomplete_evidence';
          rt.meta.repairRound = (rt.meta.repairRound || 0) + 1;
          rt.meta.gaps = remainingGaps;
          rt.meta.repairSummary = repairSummary;
          rt.meta.repairFailures = resultFailed.slice(0, 12).map((item) => ({
            reason: item.reason || 'repair_failed',
            authReason: item.authReason || null,
            pageUrl: item.pageUrl || item.action?.pageUrl || null,
            narration: item.action?.narration || item.action?.elementLabel || null,
          }));
          if (rt.meta.repairFailures.some((f) => /auth/i.test(String(f.reason || f.authReason || '')))) {
            rt.meta.handoff = 'auth_precondition_required';
          } else if (remainingGaps.length) {
            rt.meta.handoff = 'reacquisition_required';
          } else {
            delete rt.meta.handoff;
          }
          rt.meta.replayIrPatched = !!patchedReplay;
          rt.meta.replayIrPatchCount = patchResult.patchedCount || 0;
          delete rt.meta.repairStartedAt;
          try {
            await prisma.runResult.update({
              where: { id: rt.id },
              data: {
                exportMeta: JSON.stringify(rt.meta),
                ...(patchedReplay ? { replayIrJson: patchedReplay } : {}),
              },
            });
          } catch (_) {}
        }

        send({
          type: 'run.certificationRepairComplete',
          runId,
          projectId,
          resolved: resolved.length,
          failed: failed.length,
          summary: repairSummary,
        });
      } catch (err) {
        // Revert to incomplete_evidence on failure
        for (const rt of repairTargets) {
          try {
            rt.meta.state = 'incomplete_evidence';
            delete rt.meta.repairStartedAt;
            await prisma.runResult.update({ where: { id: rt.id }, data: { exportMeta: JSON.stringify(rt.meta) } });
          } catch (_) {}
        }
        send({ type: 'run.certificationRepairFailed', runId, projectId, error: err.message });
      } finally {
        if (mcpSession) {
          try { await mcp.stopMcpSession(mcpSession); } catch (_) {}
        }
      }
    });
  } catch (err) {
    next(err);
  }
});

// ── DELETE all output files for a project ────────────────
// Wipes disk artifacts (PR specs, run screenshots/video/trace) AND clears
// every TestCase.specCode + GovernancePR row for this project. The
// scenarios + test cases themselves are kept — only the generated/executed
// artifacts get nuked, so the user can re-run from the same TC list.
router.delete('/', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const { unlinked, attempted } = await clearProjectFiles(project.id);

    // Also clear the persisted specCode + drop the PR rows that referenced
    // the now-deleted disk files. GovernancePR is kept as historical audit
    // in the DB (existing rows survive); only this project's get wiped.
    const [{ count: prCount }, { count: tcCount }] = await Promise.all([
      prisma.governancePR.deleteMany({ where: { projectId: project.id } }),
      prisma.testCase.updateMany({
        where: { projectId: project.id, specCode: { not: null } },
        data: { specCode: null },
      }),
    ]);

    await audit.log({
      userId: req.user.id,
      action: 'output.clear-all',
      target: project.id,
      metadata: { filesDeleted: unlinked, filesAttempted: attempted, prDeleted: prCount, specCodeCleared: tcCount },
      req,
    });
    res.json({ success: true, filesDeleted: unlinked, prDeleted: prCount, specCodeCleared: tcCount });
  } catch (err) {
    next(err);
  }
});

// ── Legacy single-name viewer (kept for back-compat with Reports' "Generated spec" panel) ──
router.get('/:name', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const name = req.params.name;
    if (!/^[a-zA-Z0-9_.-]+\.spec\.ts$/.test(name)) {
      return res.status(400).json({ success: false, code: 'INVALID_NAME' });
    }
    // Per-run isolation: search ONLY the selected run's tests dir (resolved
    // from ?runId or latest). Falls back to NOT_FOUND if no run output
    // exists yet — the caller (Reports) will surface a "spec not generated"
    // empty state, which is correct: legacy mixed-folder behaviour is gone.
    const { run, runDir } = await resolveTargetRun(req, project);
    if (!run || !runDir) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    }
    const testsDir = path.join(runDir, 'tests');
    let foundPath = null;
    if (fs.existsSync(testsDir)) {
      const stack = [testsDir];
      while (stack.length) {
        const dir = stack.pop();
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (e.name === name) { foundPath = full; break; }
        }
        if (foundPath) break;
      }
    }
    if (!foundPath) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    res.json({ success: true, name, content: fs.readFileSync(foundPath, 'utf8') });
  } catch (err) {
    next(err);
  }
});

function readmeTemplate(project, run, isJs) {
  const runHeader = run
    ? `Run: ${run.sprintName || 'ad-hoc'}  ·  ${run.id}  ·  started ${run.startedAt ? new Date(run.startedAt).toISOString() : 'unknown'}\nSummary: ${run.passed ?? 0} passed, ${run.failed ?? 0} failed, ${run.blocked ?? 0} blocked, ${run.skipped ?? 0} skipped.\n\n`
    : '';
  const ext = isJs ? 'js' : 'ts';
  const configFile = `playwright.config.${ext}`;
  const lang = isJs ? 'JavaScript' : 'TypeScript';
  const targetUrl = project.targetUrl || 'https://your-app.example.com';
  return `# ${project.name}

${runHeader}Playwright ${lang} suite exported from QAAI. This folder is a complete,
self-contained project — open it in VS Code, install once, and run. No file
edits are required to execute the passing tests.

## Quick start

\`\`\`bash
# 1. Install dependencies (one time)
npm install

# 2. Install the Chromium browser Playwright drives (one time)
npx playwright install chromium

# 3. Run the whole suite
npx playwright test

# …or run a single spec
npx playwright test tests/<module>/<name>.spec.${ext}

# …or open the interactive UI runner
npx playwright test --ui
\`\`\`

The target URL (\`${targetUrl}\`) is baked into ${configFile} as the default
\`baseURL\`. Override it without editing code:

\`\`\`bash
QAAI_TARGET_URL=https://staging.example.com npx playwright test
\`\`\`

If any test logs in, copy \`.env.example\` to \`.env\` and fill in credentials —
the specs read them from \`process.env\`, never from hard-coded values.

## Layout

\`\`\`
pages/        Page Object classes (locators + interaction methods)
tests/        Spec files — one per test case, importing the Page Objects
fixtures/     Shared Playwright fixtures
utils/        Helpers (env access, popup dismissal, etc.)
${configFile}   Playwright configuration (baseURL, timeouts, reporters)
.vscode/      Recommended extensions + test-runner settings
\`\`\`

## View the report

\`\`\`bash
npx playwright show-report
\`\`\`

Generated by QAAI on ${new Date().toISOString()}.
`;
}

// `.env.example` — documents the credential vars the specs may reference.
// We don't know the exact names the codegen used, so we list the common ones
// and instruct the user to add any others the specs reference.
function envExample(project) {
  return `# Copy this file to ".env" and fill in real values before running tests
# that require authentication. The specs read these via process.env.

# Target application under test (overrides the baked-in default).
QAAI_TARGET_URL=${project.targetUrl || 'https://your-app.example.com'}

# Common credential variables — add/rename to match what the specs reference.
TEST_EMAIL=
TEST_PASSWORD=
TEST_USERNAME=
`;
}

// .env written on every export so QAAI_TARGET_URL is always the current project
// URL (never stale from a previous project's copy). Only includes the URL — add
// TEST_EMAIL / TEST_PASSWORD manually for suites that require authentication.
function envDotFile(project) {
  return `# Auto-written by QAAI on every "Open in VS Code" / ZIP export.
# Safe to overwrite — add TEST_EMAIL and TEST_PASSWORD below for authenticated suites.
QAAI_TARGET_URL=${project.targetUrl || ''}
`;
}

function vscodeExtensions(framework) {
  const fw = framework || '';
  let recommendations;
  if (fw.startsWith('selenium')) {
    // Java/Maven tooling; add the Cucumber/Gherkin extension for BDD.
    recommendations = ['vscjava.vscode-java-pack', 'vscjava.vscode-maven'];
    if (fw.includes('bdd')) recommendations.push('cucumberopen.cucumber-official');
  } else {
    // Playwright (TS/JS/flat/bdd); add the Cucumber/Gherkin extension for BDD.
    recommendations = ['ms-playwright.playwright', 'dbaeumer.vscode-eslint'];
    if (fw.includes('bdd')) recommendations.push('cucumberopen.cucumber-official');
  }
  return JSON.stringify({ recommendations }, null, 2) + '\n';
}

function vscodeSettings() {
  return JSON.stringify({
    'playwright.reuseBrowser': true,
    'editor.formatOnSave': false,
    'files.exclude': {
      'node_modules': true,
      'test-results': true,
      'playwright-report': true,
    },
  }, null, 2) + '\n';
}

module.exports = router;
