'use strict';
/**
 * Export OrangeHRM Module Testing run → specs → run Playwright → audit.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { execSync } = require('child_process');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const prisma = new PrismaClient();

const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
// Updated to the full 24-case run (was bc723b73 which had only 7 cases)
const RUN_ID = process.argv[2] || '2fda1038-bece-43f2-add9-0a7b0817dda3';
const OUT_DIR = path.join(__dirname, '..', 'playwright', 'runs', RUN_ID);
console.log(`Using RUN_ID: ${RUN_ID}`);

function assessSpec(content, filename) {
  const issues = [];
  const notes = [];
  if (!/(require\(|from ['"]@playwright)/.test(content)) issues.push('no import');
  if (!/(^|\n)\s*(test|it)\s*\(/.test(content)) issues.push('no test() block');
  if (!content.includes('expect(')) issues.push('no expect() assertion');
  if (!content.includes('await ')) issues.push('no await statements');
  // Only flag these when they appear as code-gen error COMMENTS (preceded by //),
  // not when they appear as string literals inside test assertions (e.g. SQL injection tests
  // legitimately check that the page does NOT contain 'syntax error').
  if (/\/\/.*(?:SYNTAX ERROR|Duplicate declaration|Missing semicolon)/i.test(content)) issues.push('SYNTAX MARKERS');
  const roleL = (content.match(/getByRole\(/g) || []).length;
  const textL = (content.match(/getByText\(/g) || []).length;
  const labelL = (content.match(/getByLabel\(/g) || []).length;
  const phL = (content.match(/getByPlaceholder\(/g) || []).length;
  const cssL = (content.match(/\.locator\(['"][\.#]/g) || []).length;
  const fragile = (content.match(/nth-child|nth-of-type|>> nth=/g) || []).length;
  const uncheckable = (content.match(/qaai-uncheckable/g) || []).length;
  notes.push(`locators: ${roleL+textL+labelL+phL} semantic, ${cssL} CSS-class, ${fragile} fragile`);
  if (uncheckable) notes.push(`qaai-uncheckable annotations: ${uncheckable}`);
  if (content.includes('process.env.') || content.includes('_env')) notes.push('uses env vars');
  if (content.includes('timeout')) notes.push('explicit timeouts');
  const cred = /(password|passwd)\s*[=:]\s*['"][^'"]{3,}/i.test(content) && !content.includes('process.env');
  if (cred) issues.push('possible hardcoded credential');
  notes.push(`${content.split('\n').length} lines`);
  return { issues, notes, clean: issues.length === 0 };
}

async function main() {
  const { buildReplayExport } = require(path.join(__dirname, '..', 'server', 'services', 'codegen', 'replayExport'));

  const project = await prisma.project.findUnique({
    where: { id: PROJECT_ID },
    select: { name: true, targetUrl: true, framework: true, testCredentials: true }
  });
  console.log(`\nProject: ${project.name}`);
  console.log(`URL: ${project.targetUrl}`);
  console.log(`Framework: ${project.framework}`);
  console.log(`Run: ${RUN_ID}\n`);

  console.log('=== STEP 1: BUILD EXPORT ===\n');
  let result;
  try {
    result = await buildReplayExport({
      projectId: PROJECT_ID,
      runId: RUN_ID,
      framework: 'playwright-reference-js',
      validate: false,
    });
  } catch (e) {
    console.error('buildReplayExport FAILED:', e.message);
    console.error(e.stack?.split('\n').slice(0, 8).join('\n'));
    await prisma.$disconnect();
    process.exit(1);
  }

  if (!result || !result.files) {
    console.error('No files in export result:', JSON.stringify(result, null, 2).slice(0, 400));
    await prisma.$disconnect();
    process.exit(1);
  }

  // Write files
  for (const [name, content] of Object.entries(result.files)) {
    if (typeof content === 'string') {
      const fpath = path.join(OUT_DIR, name);
      fs.mkdirSync(path.dirname(fpath), { recursive: true });
      fs.writeFileSync(fpath, content, 'utf8');
    }
  }
  const allFiles = Object.keys(result.files);
  const specFiles = allFiles.filter(f => /\.(spec|test)\.(ts|js)$/.test(f));
  console.log(`Export wrote ${allFiles.length} total files, ${specFiles.length} spec files:`);
  specFiles.forEach(f => console.log(`  ${f}`));

  console.log('\n=== STEP 2: STATIC AUDIT ===\n');
  let cleanCount = 0;
  for (const rel of specFiles) {
    const fpath = path.join(OUT_DIR, rel);
    const content = fs.readFileSync(fpath, 'utf8');
    const { issues, notes, clean } = assessSpec(content, path.basename(rel));
    if (clean) cleanCount++;
    console.log(`── ${rel}`);
    console.log(`   ${clean ? 'CLEAN' : 'ISSUES: ' + issues.join('; ')}`);
    notes.forEach(n => console.log(`   · ${n}`));
    // Show spec content
    console.log(`\n   SPEC:\n`);
    content.split('\n').forEach((l, i) => console.log(`   ${String(i+1).padStart(3)} | ${l}`));
    console.log('');
  }
  console.log(`Static audit: ${cleanCount}/${specFiles.length} clean\n`);

  console.log('=== STEP 3: INSTALL DEPS (if needed) ===\n');
  const pkgJson = path.join(OUT_DIR, 'package.json');
  const nmDir = path.join(OUT_DIR, 'node_modules');
  if (fs.existsSync(pkgJson) && !fs.existsSync(nmDir)) {
    try {
      execSync('npm install', { cwd: OUT_DIR, stdio: 'inherit' });
    } catch (e) {
      console.warn('npm install warning:', e.message);
    }
  } else {
    console.log('node_modules already present or no package.json, skipping npm install');
  }

  console.log('\n=== STEP 4: RUN PLAYWRIGHT TESTS ===\n');
  // Set env vars from project credentials
  const creds = project.testCredentials ? JSON.parse(project.testCredentials) : [];
  const admin = creds.find(c => c.name === 'Admin') || creds[0];
  const env = { ...process.env };
  // Explicitly override QAAI_TARGET_URL so the run-specific target wins over
  // whatever the root .env (loaded by this script's require-dotenv) injected.
  env.QAAI_TARGET_URL = project.targetUrl;
  if (admin) {
    env.QAAI_USERNAME = admin.email || admin.username || '';
    env.QAAI_PASSWORD = admin.password || '';
  }

  try {
    const out = execSync(
      'npx playwright test --reporter=list --timeout=60000',
      { cwd: OUT_DIR, env, stdio: 'pipe', timeout: 300000 }
    );
    console.log(out.toString());
  } catch (e) {
    const stdout = e.stdout ? e.stdout.toString() : '';
    const stderr = e.stderr ? e.stderr.toString() : '';
    console.log('--- Playwright output ---');
    console.log(stdout || '(no stdout)');
    if (stderr) console.log('--- stderr ---\n', stderr);
  }

  await prisma.$disconnect();
}

main().catch(async e => {
  console.error('FATAL:', e.message);
  console.error(e.stack?.split('\n').slice(0, 6).join('\n'));
  await prisma.$disconnect();
  process.exit(1);
});
