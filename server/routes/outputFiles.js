'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const prisma = require('../prisma');
const audit = require('../services/audit');
const { requireAuth } = require('../middleware/auth');

// Lazy-load archiver — server still boots if it's missing.
let _archiver = null;
function archiver() {
  if (_archiver !== null) return _archiver;
  try {
    _archiver = require('archiver');
  } catch {
    _archiver = false;
  }
  return _archiver;
}

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

const PLAYWRIGHT_DIR = path.join(__dirname, '..', '..', 'playwright');

async function ownProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, userId: req.user.id },
  });
}

// ── List ──────────────────────────────────────────────────
//
// Project isolation strategy:
//   The `playwright/` directory is shared across all projects on disk (codegen
//   writes `tests/<module>/<tcId>.spec.ts` flat, not under a per-project
//   subdir). To keep this route honest, we filter the disk walk against THIS
//   project's actual content:
//     - this project's TestCase ids (matched against UUID in the filename)
//     - this project's GovernancePR.filename rows (matched against the
//       relative path under playwright/)
//   Files that don't match either are either (a) leftovers from a deleted
//   project or (b) belong to a different project — both should be hidden
//   from this project's listing.
//
//   Shell scaffolding (playwright.config.*, package.json, tsconfig.json) is
//   only surfaced when the project has at least one generated PR — there's
//   no point showing infrastructure files for a project that has produced
//   nothing yet.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

router.get('/', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const [tcIds, prFilenames, persisted] = await Promise.all([
      prisma.testCase.findMany({
        where: { projectId: project.id },
        select: { id: true },
      }).then((rs) => new Set(rs.map((r) => r.id))),
      prisma.governancePR.findMany({
        where: { projectId: project.id },
        select: { filename: true },
      }).then((rs) => new Set(rs.map((r) => r.filename))),
      prisma.testCase.findMany({
        where: { projectId: project.id, specCode: { not: null } },
        select: { id: true, name: true, module: true, specCode: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    const files = [];
    const ROOTS = ['tests', 'pages', 'fixtures', 'utils'];
    for (const rootName of ROOTS) {
      const root = path.join(PLAYWRIGHT_DIR, rootName);
      if (!fs.existsSync(root)) continue;
      walk(root, (rel, stat) => {
        const relPosix = rootName + '/' + rel.replace(/\\/g, '/');
        if (!fileBelongsToProject(relPosix, tcIds, prFilenames)) return;
        files.push({ name: relPosix, sizeBytes: stat.size, mtime: stat.mtime });
      });
    }

    // Shell scaffolding only when the project has actually emitted code.
    if (prFilenames.size > 0) {
      for (const top of ['playwright.config.ts', 'package.json', 'tsconfig.json']) {
        const p = path.join(PLAYWRIGHT_DIR, top);
        if (fs.existsSync(p)) {
          const st = fs.statSync(p);
          files.push({ name: top, sizeBytes: st.size, mtime: st.mtime });
        }
      }
    }

    files.sort((a, b) => b.mtime - a.mtime);

    res.json({ success: true, files, persisted });
  } catch (err) {
    next(err);
  }
});

/**
 * Decide whether `relPath` (a `tests/foo.spec.ts` / `pages/Bar.ts` /
 * `fixtures/baz.ts` style POSIX path) belongs to this project.
 *
 *   - Spec files (`*.spec.ts`): the embedded UUID must be one of this
 *     project's test cases.
 *   - Files listed verbatim in this project's GovernancePR.filename: yes.
 *   - Files under fixtures/ or utils/ surface when the project has at
 *     least one PR (shared scaffolding is only relevant when this project
 *     has actually generated something).
 *   - Everything else: hidden.
 */
function fileBelongsToProject(relPath, tcIds, prFilenames) {
  if (prFilenames.has(relPath)) return true;
  if (relPath.endsWith('.spec.ts')) {
    const m = relPath.match(UUID_RE);
    if (m && tcIds.has(m[0])) return true;
    return false;
  }
  if (relPath.startsWith('fixtures/') || relPath.startsWith('utils/')) {
    return prFilenames.size > 0;
  }
  return false;
}

function walk(dir, cb, rel = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const childRel = rel ? path.join(rel, e.name) : e.name;
    const childAbs = path.join(dir, e.name);
    if (e.isDirectory()) walk(childAbs, cb, childRel);
    else cb(childRel, fs.statSync(childAbs));
  }
}

// ── Download zip ──────────────────────────────────────────
// GET /api/projects/:projectId/output-files/download.zip
router.get('/download.zip', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const arch = archiver();
    if (!arch) {
      return res
        .status(501)
        .json({ success: false, code: 'NO_ARCHIVER', message: 'archiver dep not installed' });
    }

    const persisted = await prisma.testCase.findMany({
      where: { projectId: project.id, specCode: { not: null } },
      select: { id: true, name: true, module: true, specCode: true },
    });

    const safeProjectName = project.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'qaai-project';
    const zipName = `${safeProjectName}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const z = arch('zip', { zlib: { level: 9 } });
    z.on('warning', (e) => console.warn('[zip]', e.message));
    z.on('error', (e) => {
      console.error('[zip] error', e);
      try {
        res.status(500).end();
      } catch {}
    });
    z.pipe(res);

    // 1. playwright.config.js  (real one if present, else template)
    const realConfig = path.join(PLAYWRIGHT_DIR, 'playwright.config.js');
    if (fs.existsSync(realConfig)) {
      z.file(realConfig, { name: 'playwright.config.js' });
    } else {
      z.append(playwrightConfigTemplate(project), { name: 'playwright.config.js' });
    }

    // 2. tests/*.spec.ts  — prefer files on disk; fall back to persisted code
    const testsDir = path.join(PLAYWRIGHT_DIR, 'tests');
    const onDisk = new Set();
    if (fs.existsSync(testsDir)) {
      for (const f of fs.readdirSync(testsDir).filter((x) => x.endsWith('.spec.ts'))) {
        z.file(path.join(testsDir, f), { name: `tests/${f}` });
        onDisk.add(f);
      }
    }
    for (const tc of persisted) {
      const fname = `${tc.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.spec.ts`;
      if (onDisk.has(fname)) continue;
      z.append(tc.specCode || '// (empty)', { name: `tests/${fname}` });
    }

    // 3. package.json
    z.append(JSON.stringify(packageJsonTemplate(project), null, 2) + '\n', {
      name: 'package.json',
    });

    // 4. .gitignore
    z.append('node_modules/\ntest-results/\nplaywright-report/\n', { name: '.gitignore' });

    // 5. README.md
    z.append(readmeTemplate(project, persisted.length || onDisk.size), { name: 'README.md' });

    await audit.log({
      userId: req.user.id,
      action: 'output.download',
      target: project.id,
      metadata: { specCount: persisted.length },
      req,
    });

    z.finalize();
  } catch (err) {
    next(err);
  }
});

// ── Single file viewer ────────────────────────────────────
// Accepts nested paths like tests/auth/abc.spec.ts or pages/auth/AuthPage.ts.
router.get('/file/*', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const rel = req.params[0] || '';
    // Restrict to known roots + reject path-escape attempts
    const ALLOWED = ['tests/', 'pages/', 'fixtures/', 'utils/', 'playwright.config.ts', 'package.json', 'tsconfig.json'];
    if (!ALLOWED.some((p) => rel === p || rel.startsWith(p))) {
      return res.status(400).json({ success: false, code: 'PATH_DENIED' });
    }
    const full = path.join(PLAYWRIGHT_DIR, rel);
    if (!full.startsWith(PLAYWRIGHT_DIR) || full.includes('..')) {
      return res.status(400).json({ success: false, code: 'PATH_ESCAPE' });
    }
    if (!fs.existsSync(full)) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    }
    const content = fs.readFileSync(full, 'utf8');
    res.json({ success: true, name: rel, content });
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
    // Search recursively under tests/ for a matching filename
    const testsDir = path.join(PLAYWRIGHT_DIR, 'tests');
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

// ── Templates ─────────────────────────────────────────────
function packageJsonTemplate(project) {
  const slug = (project.name || 'qaai-tests')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return {
    name: slug || 'qaai-tests',
    version: '1.0.0',
    private: true,
    description: `Playwright tests exported from QAAI for project ${project.name}`,
    scripts: {
      test: 'playwright test',
      'test:headed': 'playwright test --headed',
      'test:ui': 'playwright test --ui',
      report: 'playwright show-report',
    },
    devDependencies: {
      '@playwright/test': '^1.48.0',
    },
  };
}

function playwrightConfigTemplate(project) {
  return `const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  retries: 1,
  workers: 4,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['html'], ['list']],
  use: {
    baseURL: process.env.QAAI_TARGET_URL || ${JSON.stringify(project.targetUrl || 'https://demo.playwright.dev/todomvc')},
    headless: true,
    viewport: { width: 1280, height: 720 },
    screenshot: 'on',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
`;
}

function readmeTemplate(project, specCount) {
  return `# ${project.name}

Playwright suite exported from QAAI.

## Stats
- Specs: ${specCount}
- Framework: ${project.framework || 'playwright-pom'}
- Environment: ${project.environment || 'staging'}
- Target URL: ${project.targetUrl || '(set via env var QAAI_TARGET_URL)'}

## Run locally
\`\`\`
npm install
npx playwright install chromium
QAAI_TARGET_URL=${project.targetUrl || 'https://demo.playwright.dev/todomvc'} npx playwright test
\`\`\`

Exported on ${new Date().toISOString()}
`;
}

module.exports = router;
