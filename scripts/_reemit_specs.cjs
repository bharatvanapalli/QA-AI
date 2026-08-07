// Repair an ALREADY-GENERATED run's specs without re-running (no LLM, no
// credits). The per-module shared page object (pages/<m>/<Module>Page.ts) was
// clobbered last-write-wins, so 25 of 26 specs called methods that no longer
// existed. But each case's FULL page object survives in GovernancePR.specCode.
// Re-split every case into its OWN page-object file and rewrite that spec's
// import to point at it — exactly what the fixed pom.layout() now does for new
// runs. Then delete the stale shared page objects.
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';

// Tolerant marker parse — finds the Page Object / Test sections even when a
// review header precedes them (header is dropped; it's only comments).
function splitConcat(specCode) {
  const re = /\/\/ ─── Page Object:[^\n]*───\n([\s\S]*?)\n\n\/\/ ─── Test:[^\n]*───\n([\s\S]*)$/;
  const m = String(specCode || '').match(re);
  if (!m) return null;
  return { po: m[1].trimEnd(), test: m[2].trimEnd() };
}

(async () => {
  try {
    const run = await prisma.run.findFirst({ where: { projectId: PROJECT }, orderBy: { startedAt: 'desc' } });
    const runDir = path.join(__dirname, '..', 'playwright', 'runs', String(run.id));
    if (!fs.existsSync(runDir)) { console.log('no run dir', runDir); return; }
    const prs = await prisma.governancePR.findMany({ where: { runId: run.id }, select: { filename: true, specCode: true } });
    console.log(`run ${run.id.slice(0, 8)} · ${prs.length} PRs · dir ${runDir}`);

    let fixed = 0, skipped = 0;
    const sharedToDelete = new Set();
    for (const pr of prs) {
      const testRel = String(pr.filename || '').replace(/\\/g, '/'); // tests/<module>/<slug>.spec.ts
      const m = testRel.match(/^tests\/([^/]+)\/([^/]+)\.spec\.ts$/);
      if (!m) { skipped++; continue; }
      const moduleSlug = m[1], slug = m[2];
      const parts = splitConcat(pr.specCode);
      if (!parts || !parts.po || !parts.test) { skipped++; continue; }

      const poRel = `pages/${moduleSlug}/${slug}.page.ts`;
      // Rewrite the spec's page-object import to the per-case file. The original
      // import is `from '.../pages/<module>/<Something>Page'`; repoint it at the
      // per-case file (same ../../ depth: tests/<m>/x → ../../pages/<m>/...).
      let test = parts.test.replace(
        /(from\s+['"])([^'"]*\/pages\/[^'"]+)(['"])/g,
        (_full, a, oldPath, c) => {
          // remember the shared file we're moving away from, to delete later
          const mm = oldPath.match(/\/pages\/([^/]+)\/([^/'"]+)$/);
          if (mm) sharedToDelete.add(`pages/${mm[1]}/${mm[2]}.ts`);
          return `${a}../../pages/${moduleSlug}/${slug}.page${c}`;
        },
      );

      fs.mkdirSync(path.join(runDir, 'pages', moduleSlug), { recursive: true });
      fs.writeFileSync(path.join(runDir, poRel), parts.po + '\n', 'utf8');
      fs.mkdirSync(path.join(runDir, 'tests', moduleSlug), { recursive: true });
      fs.writeFileSync(path.join(runDir, testRel), test + '\n', 'utf8');
      fixed++;
    }

    // Remove the clobbered shared page objects (e.g. pages/pim/PimPage.ts) so
    // only the per-case files remain. Never touch the new <slug>.page.ts files.
    for (const rel of sharedToDelete) {
      if (/\.page\.ts$/.test(rel)) continue;
      const full = path.join(runDir, rel);
      if (fs.existsSync(full)) { try { fs.rmSync(full); console.log('  removed stale shared PO:', rel); } catch (_) {} }
    }
    console.log(`re-emitted ${fixed} case(s) with per-case page objects; skipped ${skipped}.`);
  } catch (e) { console.error('ERR', e.message, e.stack); } finally { await prisma.$disconnect(); process.exit(0); }
})();
