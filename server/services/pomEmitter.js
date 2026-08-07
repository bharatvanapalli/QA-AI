'use strict';

/**
 * POM emitter — turns a passing test case into a clean Playwright POM pair:
 *   1. pages/<module-slug>/<Module>Page.ts  — Page Object class (locators
 *      + interaction methods)
 *   2. tests/<scenario-slug>/<case-slug>.spec.ts — spec that imports + uses
 *      the Page Object
 *
 * The single Claude call emits BOTH files in one response, delimited by
 * explicit `// ===== FILE: ... =====` markers we parse out. The prompt
 * shows the existing gold-standard `LoginPage.ts` as a one-shot example
 * so generated code converges on the same shape.
 *
 * When a Page Object already exists for the module on disk, its current
 * contents are included in the prompt — the AI is told to EXTEND it
 * (preserving everything that's already there) rather than overwrite. This
 * is best-effort: if Claude misbehaves, the worst case is the file gets
 * regenerated from scratch.
 *
 * The emitter intentionally does NOT touch playwright/playwright.config.ts,
 * package.json, tsconfig.json, fixtures/, utils/ — those are project-level
 * scaffolding the user owns. We only write to pages/ and tests/.
 */

const fs = require('fs');
const path = require('path');
const { getProvider } = require('../lib/llmProvider');
const prisma = require('../prisma');

const PLAYWRIGHT_DIR = path.join(__dirname, '..', '..', 'playwright');
// Phase F.1 — per-run isolation. Every emit goes into a run-scoped subtree
// so consecutive runs never overwrite or collide with each other's output.
// Each run is a self-contained, ZIP-able Playwright workspace.
const RUNS_ROOT = path.join(PLAYWRIGHT_DIR, 'runs');
function runDir(runId) {
  if (!runId) throw new Error('pomEmitter requires runId for per-run isolation');
  return path.join(RUNS_ROOT, String(runId));
}
function pagesDirFor(runId) { return path.join(runDir(runId), 'pages'); }
function testsDirFor(runId) { return path.join(runDir(runId), 'tests'); }

// One-shot exemplar. Inlined so the AI doesn't have to fetch it.
// Kept short — Claude has the pattern from training, this just nudges
// it toward the project's specific conventions (private readonly Locators,
// async methods with timeouts, ARIA-first locators).
const EXEMPLAR_PAGE = `import { Page, Locator } from '@playwright/test';

export class LoginPage {
  readonly page: Page;
  private readonly usernameInput: Locator;
  private readonly passwordInput: Locator;
  private readonly submitButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.usernameInput = page.getByLabel('Username');
    this.passwordInput = page.getByLabel('Password');
    this.submitButton = page.getByRole('button', { name: /login/i });
  }

  async navigateToLogin(): Promise<void> {
    await this.page.goto('https://example.com/login');
    await this.usernameInput.waitFor({ state: 'visible', timeout: 10_000 });
  }

  async login(username: string, password: string): Promise<void> {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  getUsernameInputLocator(): Locator {
    return this.usernameInput;
  }
}`;

const EXEMPLAR_SPEC = `import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/login/LoginPage';

test.describe('Login', () => {
  test('logs in with valid credentials', async ({ page }) => {
    const login = new LoginPage(page);
    await login.navigateToLogin();
    await login.login('practice', 'SuperSecretPassword!');
    await expect(page).toHaveURL(/secure/i);
    await page.screenshot({ path: 'test-results/login-success.png', fullPage: false });
  });
});`;

// ── Slugs / paths ─────────────────────────────────────────
function slug(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

function pascal(s) {
  return (s || '')
    .toString()
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join('') || 'Page';
}

function targetPaths({ runId, module, scenarioName, caseName }) {
  const moduleSlug = slug(module);
  const scenarioSlug = slug(scenarioName);
  const caseSlug = slug(caseName);
  const className = `${pascal(module)}Page`;
  return {
    moduleSlug, scenarioSlug, caseSlug, className,
    // Absolute disk paths — scoped under playwright/runs/<runId>/.
    pageAbs: path.join(pagesDirFor(runId), moduleSlug, `${className}.ts`),
    specAbs: path.join(testsDirFor(runId), scenarioSlug, `${caseSlug}.spec.ts`),
    // UI-visible paths — relative to the run dir, NOT to the playwright
    // root. The Output Files page treats each run as its own workspace,
    // so users see clean `pages/auth/LoginPage.ts` without the runId
    // prefix cluttering every breadcrumb.
    pageRel: `pages/${moduleSlug}/${className}.ts`,
    specRel: `tests/${scenarioSlug}/${caseSlug}.spec.ts`,
    // Relative import path from spec → page object. Specs sit two levels
    // deep (tests/<scenarioSlug>/file), so we step up twice then descend
    // into pages/. The runId dir wraps both so this relative path stays
    // valid regardless of where the run dir lives on disk.
    importPath: `../../pages/${moduleSlug}/${className}`,
  };
}

// ── Prompt + parsing ──────────────────────────────────────
function buildSystemPrompt() {
  return `You are a senior Playwright POM engineer. You produce production-quality
TypeScript test artifacts in the Page Object Model pattern.

OUTPUT FORMAT — STRICT:
Emit EXACTLY two files. Each delimited by markers. No commentary outside markers.
No markdown fences anywhere.

// ===== FILE: <pageRel> =====
<TypeScript code for the Page Object>
// ===== END FILE =====

// ===== FILE: <specRel> =====
<TypeScript code for the spec that uses the Page Object>
// ===== END FILE =====

PAGE OBJECT RULES:
- Class name supplied by the caller (e.g. RegistrationPage, LoginPage).
- Properties: \`readonly page: Page;\` plus \`private readonly <name>: Locator;\` per element.
- Locator preference order: getByRole > getByLabel > getByPlaceholder > getByTestId > getByText > CSS.
  Never invent fragile CSS — if you don't know a stable selector, use the most semantic one available.
- Methods: async, with \`await locator.waitFor({ state: 'visible', timeout: 10_000 })\` before interaction.
- Expose raw locators via public getters when the spec needs to assert on them.
- Constructor signature: \`constructor(page: Page)\`.

SPEC RULES:
- Single \`test.describe\` block, single \`test(...)\` inside, scope to ONE test case.
- Import the Page Object via the relative path the caller specifies.
- No \`page.waitForTimeout\` — only proper Playwright waits.
- End with \`await page.screenshot({ path: 'test-results/<caseSlug>.png' })\`.
- Use \`expect(...)\` from \`@playwright/test\` for every declared assertion.

EXAMPLE OF THE EXPECTED SHAPE (your output should match this style):

${EXEMPLAR_PAGE}

${EXEMPLAR_SPEC}

EXTENDING AN EXISTING PAGE OBJECT:
If the caller provides an "existingPageObject" block, your Page Object MUST
include every property and method from it verbatim AND add new ones for
locators/methods this new case needs. Never delete existing methods.`;
}

function buildUserPrompt({ project, testCase, scenario, paths, existingPageObject, verifiedLocators }) {
  const steps = (testCase.stepsParsed || [])
    .map((s, i) => `${i + 1}. ${s.action}${s.target ? ' — ' + s.target : ''}${s.value ? ' (value: ' + s.value + ')' : ''}${s.expected ? ' → expect: ' + s.expected : ''}`)
    .join('\n');

  // Build the verified-locators section from the project's Knowledge Base.
  // These are selectors that were captured by the MCP accessibility tree and
  // confirmed to work on this site — the generated spec must use them verbatim
  // rather than inventing new locators. This is the primary trust surface.
  let verifiedLocatorsSection = '';
  if (verifiedLocators && verifiedLocators.length > 0) {
    const lines = verifiedLocators.map((l) => {
      let expr = '';
      const esc = (s) => String(s || '').replace(/'/g, "\\'");
      if (l.strategy === 'role' && l.role && l.accessibleName) {
        expr = `page.getByRole('${esc(l.role)}', { name: '${esc(l.accessibleName)}' })`;
      } else if (l.strategy === 'testid' && l.selector) {
        expr = `page.getByTestId('${esc(l.selector)}')`;
      } else if (l.strategy === 'label' && l.selector) {
        expr = `page.getByLabel('${esc(l.selector)}')`;
      } else if (l.strategy === 'text' && l.selector) {
        expr = `page.getByText('${esc(l.selector)}')`;
      } else if (l.selector) {
        expr = `page.locator('${esc(l.selector)}')`;
      }
      return expr ? `- ${l.element}: ${expr}  [verified ${l.occurrences}× · health ${l.healthScore}]` : null;
    }).filter(Boolean);
    if (lines.length) {
      verifiedLocatorsSection = `\nVERIFIED LOCATORS — use these exact Playwright expressions. They were captured from the real accessibility tree and confirmed to work on this site. Do NOT invent locators for elements that appear in this list.\n${lines.join('\n')}\n`;
    }
  }

  return `Generate the Page Object and spec for this test case.
${verifiedLocatorsSection}
PROJECT
- Name: ${project.name}
- Target URL: ${project.targetUrl || '(unknown — derive from the steps)'}
- Framework: playwright-pom

TEST CASE
- Name: ${testCase.name}
- Module: ${testCase.module}
- Scenario: ${scenario?.name || '(none)'}
- Type: ${testCase.type}
- Assertions: ${testCase.assertions}

STEPS:
${steps || '(no steps recorded — base on the assertions)'}

FILE PATHS (emit exactly these in the file markers):
- Page Object: ${paths.pageRel}    (class name: ${paths.className})
- Spec:        ${paths.specRel}
- Import in spec: import { ${paths.className} } from '${paths.importPath}';

${existingPageObject ? `EXISTING PAGE OBJECT (extend, do not replace — preserve every property and method below):

${existingPageObject}
` : 'No existing Page Object — create from scratch.'}

Emit the two files now.`;
}

// Parses Claude's response into two files. Defensive — tolerates extra
// blank lines, missing END markers, etc.
function parseTwoFiles(text) {
  if (!text || typeof text !== 'string') return [];
  const fileRegex = /\/\/\s*=+\s*FILE:\s*([^\s=]+)\s*=+\s*([\s\S]*?)(?=\/\/\s*=+\s*(?:END\s+FILE|FILE:)|$)/g;
  const out = [];
  let m;
  while ((m = fileRegex.exec(text)) !== null) {
    const filePath = m[1].trim();
    let content = m[2];
    // Trim leading END markers we may have over-captured + trailing ones.
    content = content.replace(/\/\/\s*=+\s*END\s+FILE\s*=+\s*$/m, '').trim();
    if (filePath && content) out.push({ path: filePath, content });
  }
  return out;
}

// ── Disk IO ───────────────────────────────────────────────
function readExistingPage(absPath) {
  try {
    if (fs.existsSync(absPath)) return fs.readFileSync(absPath, 'utf8');
  } catch (_) {}
  return null;
}

// Structural sanity check on generated TypeScript. TypeScript isn't installed
// server-side so we use brace balance + presence checks — cheap, catches the
// two most common LLM generation failures: (a) truncated output leaves
// unclosed function/class bodies, (b) the LLM emits prose instead of code.
// Returns { valid: true } or { valid: false, reason: string }.
function checkGeneratedSyntax(content, kind) {
  if (!content || typeof content !== 'string' || !content.trim()) {
    return { valid: false, reason: 'empty content' };
  }
  // Brace balance: unbalanced output means truncation or stray prose.
  let depth = 0;
  let inString = false;
  let strChar = '';
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (ch === strChar && content[i - 1] !== '\\') inString = false;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inString = true; strChar = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth < 0) return { valid: false, reason: 'unbalanced braces (extra closing brace)' };
    }
  }
  if (depth !== 0) return { valid: false, reason: `unbalanced braces (${depth} unclosed)` };

  if (kind === 'spec') {
    // Spec files must have at least one test block.
    if (!/test\s*[\.(]/.test(content)) {
      return { valid: false, reason: 'no test() or test.describe() found in spec file' };
    }
  } else if (kind === 'page') {
    // Page-object files must export a class.
    if (!/\bclass\s+\w/.test(content)) {
      return { valid: false, reason: 'no class definition found in page-object file' };
    }
  }
  return { valid: true };
}

function writeFileSafe(absPath, content, kind) {
  const check = checkGeneratedSyntax(content, kind);
  let finalContent = content;
  if (!check.valid) {
    console.warn(`[pomEmitter] syntax warning on ${path.basename(absPath)}: ${check.reason}`);
    // Prepend a comment so the issue is visible when the file is opened or
    // reviewed in the Output Files page — don't block the write.
    finalContent = `// QAAI CODEGEN WARNING: generated file may be incomplete — ${check.reason}.\n// Review before running. Re-merge from Governance to regenerate.\n\n${content}`;
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, finalContent, 'utf8');
}

/**
 * Emit POM files for a single passing TestCase.
 *
 * @param {object} opts
 * @param {string} opts.apiKey      — provider API key (already decrypted)
 * @param {string} opts.model       — provider model id
 * @param {string} opts.provider    — 'claude' | 'gemini'
 * @param {object} opts.project     — { name, targetUrl }
 * @param {object} opts.testCase    — { id, name, module, type, assertions, steps? } (steps may be JSON string)
 * @param {object} opts.scenario    — { name } (optional; falls back to module)
 * @returns {Promise<{ written: Array<{path, abs}>, skipped?: string }>}
 */
async function emitForCase({ apiKey, model, provider: providerName, project, testCase, scenario, runId }) {
  if (!apiKey) return { written: [], skipped: 'no-api-key' };
  if (!testCase?.module) return { written: [], skipped: 'no-module' };
  if (!testCase?.name) return { written: [], skipped: 'no-name' };
  if (!runId) return { written: [], skipped: 'no-run-id' };

  const provider = getProvider(providerName);

  // Steps may already be parsed (object[]) or come from DB as a JSON string.
  let stepsParsed = [];
  if (Array.isArray(testCase.steps)) stepsParsed = testCase.steps;
  else if (typeof testCase.steps === 'string') {
    try { const v = JSON.parse(testCase.steps); if (Array.isArray(v)) stepsParsed = v; } catch (_) {}
  }
  const tcWithSteps = { ...testCase, stepsParsed };

  const paths = targetPaths({
    runId,
    module: testCase.module,
    scenarioName: scenario?.name || testCase.module,
    caseName: testCase.name,
  });
  const existingPageObject = readExistingPage(paths.pageAbs);

  // Load the top verified locators from the project's Knowledge Base.
  // These are selectors the conductor confirmed on the real site — injecting
  // them into the prompt means the generated spec uses the same expressions
  // that already worked rather than hallucinating new ones.
  let verifiedLocators = [];
  if (project?.id) {
    try {
      verifiedLocators = await prisma.knowledgeBaseLocator.findMany({
        where: { projectId: project.id, healthScore: { gte: 50 } },
        orderBy: [{ healthScore: 'desc' }, { occurrences: 'desc' }],
        take: 40,
        select: { element: true, selector: true, strategy: true, accessibleName: true, role: true, healthScore: true, occurrences: true },
      });
    } catch (_) { /* non-fatal — codegen proceeds without KB context */ }
  }

  const system = buildSystemPrompt();
  const user = buildUserPrompt({ project, testCase: tcWithSteps, scenario, paths, existingPageObject, verifiedLocators });

  let resp;
  try {
    resp = await provider.complete({
      apiKey,
      model,
      maxTokens: 4_000,
      system,
      messages: [{ role: 'user', content: user }],
    });
  } catch (err) {
    return { written: [], skipped: `provider-error:${err.message}` };
  }

  const text = (resp.content?.[0]?.text || '').trim();
  let files = parseTwoFiles(text);

  // Gemini sometimes wraps the two files in a JSON object instead of using
  // the // ===== FILE: ===== markers — either as a top-level JSON response or
  // with markers wrapping a JSON blob. Detect both cases and extract the
  // real TypeScript from the structured fields.
  if (!files.length || files.some((f) => f.content.trimStart().startsWith('{'))) {
    const jsonText = files.length ? files[0].content : text;
    try {
      const parsed = JSON.parse(jsonText);
      const jsonFiles = [];
      if (parsed.pageObject?.path && parsed.pageObject?.content) {
        jsonFiles.push({ path: parsed.pageObject.path, content: parsed.pageObject.content });
      }
      if (parsed.test?.path && parsed.test?.content) {
        jsonFiles.push({ path: parsed.test.path, content: parsed.test.content });
      }
      if (jsonFiles.length) files = jsonFiles;
    } catch (_) { /* not JSON, keep whatever parseTwoFiles returned */ }
  }

  if (!files.length) return { written: [], skipped: 'no-files-parsed' };

  // Match each parsed file to either pageRel or specRel by filename
  // suffix. This is more robust than relying on Claude to emit the exact
  // path string we asked for.
  const pageFile = files.find((f) => f.path.endsWith(`${paths.className}.ts`) || f.path.startsWith('pages/'));
  const specFile = files.find((f) => f.path.endsWith('.spec.ts') || f.path.startsWith('tests/'));

  const written = [];
  if (pageFile?.content) {
    writeFileSafe(paths.pageAbs, pageFile.content, 'page');
    written.push({ path: paths.pageRel, abs: paths.pageAbs });
  }
  if (specFile?.content) {
    writeFileSafe(paths.specAbs, specFile.content, 'spec');
    written.push({ path: paths.specRel, abs: paths.specAbs });
  }
  return { written, skipped: written.length ? null : 'nothing-matched' };
}

module.exports = { emitForCase, targetPaths, parseTwoFiles };
