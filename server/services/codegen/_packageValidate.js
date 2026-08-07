'use strict';

const fs = require('fs');
const { builtinModules } = require('module');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLAYWRIGHT_FRAMEWORKS = new Set([
  'playwright-pom',
  'playwright-pom-js',
  'playwright-reference',
  'playwright-reference-js',
  'playwright-flat',
  'playwright-js',
  'playwright-bdd',
  'cucumber-playwright',
  'replayir-bdd',
]);
const PLAYWRIGHT_BDD_FRAMEWORKS = new Set([
  'playwright-bdd',
  'cucumber-playwright',
  'replayir-bdd',
]);
const SELENIUM_FRAMEWORKS = new Set([
  'selenium-java',
  'selenium-reference',
  'selenium-pom',
  'selenium-bdd',
  'selenium-bdd-reference',
]);
const SELENIUM_BDD_FRAMEWORKS = new Set(['selenium-bdd', 'selenium-bdd-reference']);

const DEFAULT_TIMEOUT_MS = 45_000;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_DEP_PATHS = [path.join(REPO_ROOT, 'server'), REPO_ROOT];
// Use the OS temp dir so scratch dirs never land inside the project root.
// Previously this was path.join(REPO_ROOT, 'server'), which put tsconfig.json
// and playwright-report/ inside the watched src tree — Vite detected the new
// tsconfig and forced a full page reload on every codegen validation run.
const VALIDATION_TMP_ROOT = os.tmpdir();
const SKIP_DIRS = new Set([
  'node_modules',
  'test-results',
  'playwright-report',
  'target',
  '.git',
  '.playwright',
]);
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, '')]));
const MODULE_SOURCE_RE = /\.(?:cjs|js|mjs|ts|tsx)$/i;
const MODULE_RESOLUTION_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json'];
const GLYPH_CONTAMINATION_RE = /[\uE000-\uF8FF\u2600-\u27BF]|(?:ï|ð|â|Ã|�)[\w\u0080-\u00ff�]{0,8}/;

function finding(rule, severity, relPath, line, message, snippet) {
  return {
    rule,
    severity,
    path: relPath || null,
    line: line || 1,
    message,
    snippet: snippet ? String(snippet).trim().slice(0, 220) : undefined,
    engine: 'package',
  };
}

function normalizeFramework(framework) {
  return String(framework || '')
    .trim()
    .toLowerCase();
}

function safeRel(rel) {
  const normalized = path.normalize(String(rel || '')).replace(/^([/\\])+/, '');
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('..') ||
    path.isAbsolute(normalized)
  )
    return null;
  return normalized;
}

function copyTree(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (!stat.isDirectory()) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function writeOverlay(root, files) {
  for (const [rel, content] of Object.entries(files || {})) {
    if (typeof content !== 'string') continue;
    const clean = safeRel(rel);
    if (!clean) continue;
    const full = path.join(root, clean);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

function makeScratch(projectRoot, files) {
  const base = fs.mkdtempSync(path.join(VALIDATION_TMP_ROOT, '.qaai-package-validation-'));
  copyTree(projectRoot, base);
  writeOverlay(base, files);
  return base;
}

function cleanupScratch(dir) {
  if (!dir) return;
  const resolved = path.resolve(dir);
  const tmp = path.resolve(VALIDATION_TMP_ROOT);
  if (!path.basename(resolved).startsWith('.qaai-package-validation-')) return;
  if (!resolved.startsWith(tmp + path.sep)) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (_) {}
}

function resolvePackage(name, paths) {
  const search = [...(paths || []), ...DEFAULT_DEP_PATHS].filter(Boolean);
  try {
    return require.resolve(`${name}/package.json`, { paths: search });
  } catch (_) {
    return null;
  }
}

function packageRoot(name, paths) {
  const pkg = resolvePackage(name, paths);
  return pkg ? path.dirname(pkg) : null;
}

function packageBin(name, binName, paths) {
  const pkgPath = resolvePackage(name, paths);
  if (!pkgPath) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bin =
      typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && (pkg.bin[binName] || pkg.bin[name]);
    return bin ? path.join(path.dirname(pkgPath), bin) : null;
  } catch (_) {
    return null;
  }
}

function packageInstallPath(name) {
  const parts = String(name || '')
    .split('/')
    .filter(Boolean);
  return path.join('node_modules', ...parts);
}

function mirrorPackageIntoScratch(name, scratch, paths) {
  const root = packageRoot(name, paths);
  if (!root) return false;
  copyTree(root, path.join(scratch, packageInstallPath(name)));
  return true;
}

function runNodeCli(cliPath, args, cwd, timeoutMs) {
  if (!cliPath || !fs.existsSync(cliPath)) {
    return { status: null, stdout: '', stderr: 'CLI not found', error: { code: 'ENOENT' } };
  }
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      CI: '1',
      QAAI_TARGET_URL: process.env.QAAI_TARGET_URL || 'https://example.com',
    },
  });
}

function runMaven(args, cwd, timeoutMs) {
  // Windows + newer Node refuse to spawn a .cmd/.bat without a shell (EINVAL); without this the
  // spawn failure is misread as a compile failure. The args are fixed flags (no spaces / no user
  // input), so the single-string shell form is safe and avoids the args+shell deprecation.
  const useShell = process.platform === 'win32';
  const opts = {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      CI: '1',
      QAAI_TARGET_URL: process.env.QAAI_TARGET_URL || 'https://example.com',
    },
  };
  if (useShell) return spawnSync(['mvn.cmd', ...args].join(' '), { ...opts, shell: true });
  return spawnSync('mvn', args, opts);
}

function commandOutput(result) {
  return [result?.stdout || '', result?.stderr || ''].join('\n').trim();
}

function isMissingDependencyOutput(output) {
  return /Cannot access .* in offline mode|was not found in .* local repository|Could not resolve dependencies|Could not find artifact|No plugin found for prefix|Plugin .* not found|Non-resolvable parent POM/i.test(
    String(output || ''),
  );
}

function isCommandMissing(result) {
  return (
    result?.error &&
    (result.error.code === 'ENOENT' ||
      result.error.code === 'UNKNOWN' ||
      result.error.code === 'EINVAL')
  );
}

function countListedTests(output) {
  const text = String(output || '');
  const total = text.match(/Total:\s*(\d+)\s+tests?/i);
  if (total) return Number(total[1]);
  const matching = text
    .split(/\r?\n/)
    .filter((line) => /\s[›>]\s/.test(line) || /^\s*\[[^\]]+\]\s+.+\.spec\./i.test(line));
  return matching.length;
}

function walkFiles(root, predicate, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, predicate, out);
    else if (entry.isFile() && (!predicate || predicate(full))) out.push(full);
  }
  return out;
}

function relPath(root, full) {
  return path.relative(root, full).replace(/\\/g, '/');
}

function lineOf(text, index) {
  return String(text || '')
    .slice(0, Math.max(0, index))
    .split(/\r?\n/).length;
}

function readJsonSafe(full, fallback) {
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function dependencySections(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    dependencies:
      source.dependencies && typeof source.dependencies === 'object' ? source.dependencies : {},
    devDependencies:
      source.devDependencies && typeof source.devDependencies === 'object'
        ? source.devDependencies
        : {},
    optionalDependencies:
      source.optionalDependencies && typeof source.optionalDependencies === 'object'
        ? source.optionalDependencies
        : {},
  };
}

function stableDependencyMap(value) {
  return Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
}

function collectNpmManifestFindings(root) {
  const findings = [];
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const pkg = readJsonSafe(packagePath, null);
  if (!pkg) {
    findings.push(
      finding(
        'package_json_invalid',
        'error',
        'package.json',
        1,
        'package.json is missing or invalid JSON.',
      ),
    );
    return findings;
  }
  const isPlaywrightPomJs =
    pkg.name === 'qaai-replayir-export' &&
    pkg.type === 'module' &&
    pkg.devDependencies &&
    Object.prototype.hasOwnProperty.call(pkg.devDependencies, '@playwright/test');
  if (!fs.existsSync(lockPath)) {
    if (isPlaywrightPomJs)
      findings.push(
        finding(
          'package_lock_missing',
          'error',
          'package-lock.json',
          1,
          'Playwright POM JavaScript requires its authoritative package-lock.json.',
        ),
      );
    return findings;
  }
  const lock = readJsonSafe(lockPath, null);
  if (!lock || lock.lockfileVersion !== 3) {
    findings.push(
      finding(
        'package_lock_invalid',
        'error',
        'package-lock.json',
        1,
        'package-lock.json must be valid lockfileVersion 3 JSON.',
      ),
    );
    return findings;
  }
  const lockRoot = lock.packages && lock.packages[''];
  if (!lockRoot || typeof lockRoot !== 'object') {
    findings.push(
      finding(
        'package_lock_root_missing',
        'error',
        'package-lock.json',
        1,
        'package-lock.json is missing packages[""].',
      ),
    );
    return findings;
  }
  if (lockRoot.name !== pkg.name || lockRoot.version !== pkg.version) {
    findings.push(
      finding(
        'package_lock_identity_mismatch',
        'error',
        'package-lock.json',
        1,
        'package-lock root name/version must match package.json.',
      ),
    );
  }
  const packageSections = dependencySections(pkg);
  const lockSections = dependencySections(lockRoot);
  for (const section of Object.keys(packageSections)) {
    const expected = stableDependencyMap(packageSections[section]);
    const actual = stableDependencyMap(lockSections[section]);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      findings.push(
        finding(
          'package_lock_root_dependency_mismatch',
          'error',
          'package-lock.json',
          1,
          `package-lock root ${section} must exactly match package.json.`,
        ),
      );
    }
    if (!isPlaywrightPomJs) continue;
    for (const [name, version] of Object.entries(expected)) {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version))) {
        findings.push(
          finding(
            'package_dependency_not_exact',
            'error',
            'package.json',
            1,
            `${name} must use an exact version, not ${version}.`,
          ),
        );
        continue;
      }
      const locked = lock.packages[`node_modules/${name}`];
      if (!locked || locked.version !== version) {
        findings.push(
          finding(
            'package_dependency_lock_version_mismatch',
            'error',
            'package-lock.json',
            1,
            `${name} must be locked at exactly ${version}.`,
          ),
        );
      }
      if (!locked || !/^sha512-[A-Za-z0-9+/=]+$/.test(String(locked.integrity || ''))) {
        findings.push(
          finding(
            'package_dependency_lock_integrity_missing',
            'error',
            'package-lock.json',
            1,
            `${name} must have sha512 integrity.`,
          ),
        );
      }
    }
  }
  return findings;
}

function moduleSpecifiers(text) {
  const found = [];
  const source = maskJavaScriptComments(String(text || ''));
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w*\s{},]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)))
      found.push({ specifier: match[1], index: match.index });
  }
  return found.filter(
    (entry, index) =>
      found.findIndex(
        (candidate) => candidate.specifier === entry.specifier && candidate.index === entry.index,
      ) === index,
  );
}

function maskJavaScriptComments(text) {
  const chars = Array.from(String(text || ''));
  let state = 'code';
  let escaped = false;
  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index];
    const next = chars[index + 1];
    if (state === 'line_comment') {
      if (ch === '\n' || ch === '\r') state = 'code';
      else chars[index] = ' ';
      continue;
    }
    if (state === 'block_comment') {
      if (ch === '*' && next === '/') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (ch !== '\n' && ch !== '\r') chars[index] = ' ';
      continue;
    }
    if (state !== 'code') {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') || (state === 'template' && ch === '`')) state = 'code';
      continue;
    }
    if (ch === "'") state = 'single';
    else if (ch === '"') state = 'double';
    else if (ch === '`') state = 'template';
    else if (ch === '/' && next === '/') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 1;
      state = 'line_comment';
    } else if (ch === '/' && next === '*') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 1;
      state = 'block_comment';
    }
  }
  return chars.join('');
}

function barePackageName(specifier) {
  const value = String(specifier || '');
  if (value.startsWith('@')) return value.split('/').slice(0, 2).join('/');
  return value.split('/')[0];
}

function resolveRelativeModule(root, sourceFile, specifier) {
  const clean = String(specifier || '').split(/[?#]/)[0];
  const base = path.resolve(path.dirname(sourceFile), clean);
  const rootPath = path.resolve(root);
  if (base !== rootPath && !base.startsWith(rootPath + path.sep))
    return { exists: false, escaped: true };
  const candidates = path.extname(base)
    ? [base]
    : [
        base,
        ...MODULE_RESOLUTION_EXTENSIONS.map((ext) => `${base}${ext}`),
        ...MODULE_RESOLUTION_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
      ];
  return {
    exists: candidates.some(
      (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
    ),
    escaped: false,
  };
}

function collectModuleClosureFindings(root) {
  const findings = [];
  const pkg = readJsonSafe(path.join(root, 'package.json'), {});
  const declared = new Set(
    Object.keys(Object.assign({}, ...Object.values(dependencySections(pkg)))),
  );
  const esmPackage = pkg.type === 'module';
  const sourceFiles = walkFiles(root, (full) => MODULE_SOURCE_RE.test(full));
  for (const full of sourceFiles) {
    const rel = relPath(root, full);
    const text = fs.readFileSync(full, 'utf8');
    for (const entry of moduleSpecifiers(text)) {
      const specifier = entry.specifier;
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const resolved = resolveRelativeModule(root, full, specifier);
        if (resolved.escaped) {
          findings.push(
            finding(
              'package_relative_import_escapes_root',
              'error',
              rel,
              lineOf(text, entry.index),
              `Relative import ${specifier} escapes the generated package root.`,
            ),
          );
        } else if (!resolved.exists) {
          findings.push(
            finding(
              'package_relative_import_missing',
              'error',
              rel,
              lineOf(text, entry.index),
              `Relative import ${specifier} does not resolve to a generated file.`,
            ),
          );
        }
        if (
          esmPackage &&
          /\.(?:js|mjs)$/i.test(rel) &&
          !path.posix.extname(specifier.split(/[?#]/)[0])
        ) {
          findings.push(
            finding(
              'package_esm_import_extension_missing',
              'error',
              rel,
              lineOf(text, entry.index),
              `ESM relative import ${specifier} must include its source extension.`,
            ),
          );
        }
        continue;
      }
      if (/^(?:node:|https?:|data:|#)/.test(specifier)) continue;
      const packageName = barePackageName(specifier);
      if (NODE_BUILTINS.has(packageName)) continue;
      if (!declared.has(packageName)) {
        findings.push(
          finding(
            'package_bare_import_undeclared',
            'error',
            rel,
            lineOf(text, entry.index),
            `Bare import ${specifier} requires ${packageName} to be declared in package.json.`,
          ),
        );
      }
    }
  }
  return findings;
}

function dataFilePathFromSpec(specText, specRel, dataPath) {
  const normalized = String(dataPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (normalized.startsWith('tests/data/')) return normalized;
  const specDir = path.posix.dirname(specRel);
  return path.posix.normalize(path.posix.join(specDir, normalized));
}

function hasRowBindingBefore(text, index) {
  const before = String(text || '').slice(0, Math.max(0, index));
  return (
    /for\s*\(\s*const\s+row\s+of\b/.test(before) ||
    /test\.each(?:<[^>]+>)?\s*\([^)]*\)\s*\([\s\S]*?,\s*row\b[\s\S]*?=>/.test(before) ||
    /(?:const|let|var)\s+row(?:\s*:[^=]+)?\s*=/.test(before)
  );
}

function collectStaticPackageFindings(root, framework) {
  const findings = [];
  const sourceFiles = walkFiles(root, (full) => /\.(js|ts|mjs|cjs|json)$/i.test(full));
  for (const full of sourceFiles) {
    const rel = relPath(root, full);
    const text = fs.readFileSync(full, 'utf8');
    if (/^locators\//.test(rel) && GLYPH_CONTAMINATION_RE.test(text)) {
      findings.push(
        finding(
          'package_locator_glyph_text',
          'error',
          rel,
          lineOf(text, text.search(GLYPH_CONTAMINATION_RE)),
          'Generated locator file contains icon-font/private-use or corrupted glyph text. Exported locators must use human-stable names or scoped selectors.',
        ),
      );
    }
    const markerIdx = text.search(/QAAI_UNRESOLVED|QAAI_CODEGEN_ERROR|kbMiss|\[ref\s*=/i);
    if (markerIdx >= 0) {
      findings.push(
        finding(
          'package_internal_marker_leak',
          'error',
          rel,
          lineOf(text, markerIdx),
          'Generated package contains an internal marker/ref that must never reach runnable output.',
        ),
      );
    }
    if (/^tests\/.+\.spec\.(js|ts)$/i.test(rel) && /\.first\(\)/.test(text)) {
      findings.push(
        finding(
          'package_spec_first_locator',
          'error',
          rel,
          lineOf(text, text.indexOf('.first()')),
          'Generated specs must not use .first() to hide ambiguous locators.',
        ),
      );
    }
    if (
      /^tests\/.+\.spec\.(js|ts)$/i.test(rel) &&
      /assertScopedText\(\s*page\s*,\s*['"][^'"]*(?:features_items|productinfo|single-products|product-image-wrapper|\[class\*="product"\])/i.test(
        text,
      )
    ) {
      findings.push(
        finding(
          'package_broad_product_assertion',
          'error',
          rel,
          lineOf(text, text.search(/assertScopedText\(/)),
          'Product assertions should be emitted through page-object assertion methods, not broad support-helper scans.',
        ),
      );
    }
  }

  const specFiles = sourceFiles.filter((full) =>
    /^tests\/.+\.spec\.(js|ts)$/i.test(relPath(root, full)),
  );
  for (const full of specFiles) {
    const rel = relPath(root, full);
    const text = fs.readFileSync(full, 'utf8');
    if (
      /combined-search-and-category|women.*dress|dress.*women/i.test(`${rel}\n${text}`) &&
      /searchForProduct\(/.test(text) &&
      !/selectCategory\(\s*["']Women["']\s*,\s*["']Dress["']\s*\)/.test(text)
    ) {
      findings.push(
        finding(
          'package_semantic_missing_category_prerequisite',
          'error',
          rel,
          1,
          'Combined search/category flow asserts Women Dress state without selecting Women > Dress first.',
        ),
      );
    }
    if (
      /(clear|reset|restore).*(search|grid|products)|search.*(clear|reset|restore)/i.test(
        `${rel}\n${text}`,
      ) &&
      /searchForProduct\(/.test(text) &&
      !/(clearSearch\(\)|page\.goto\(\s*["']\/products["']\s*\))/.test(text)
    ) {
      findings.push(
        finding(
          'package_semantic_missing_reset_action',
          'error',
          rel,
          1,
          'Clear/reset search flow asserts restored grid without a clear/reset/navigation action.',
        ),
      );
    }

    const loadMatch = [...text.matchAll(/loadDataRows\(\s*["']([^"']+)["']\s*\)/g)];
    const readKeys = [...text.matchAll(/readData\(\s*row\s*,\s*["']([^"']+)["']/g)].map(
      (m) => m[1],
    );
    const readMatches = [...text.matchAll(/readData\(\s*row\s*,\s*["'][^"']+["']/g)];
    for (const readMatch of readMatches) {
      if (!hasRowBindingBefore(text, readMatch.index)) {
        findings.push(
          finding(
            'package_data_row_unscoped',
            'error',
            rel,
            lineOf(text, readMatch.index),
            `${rel} calls readData(row, "...") before any row binding is declared.`,
          ),
        );
      }
    }
    if (loadMatch.length && readKeys.length === 0) {
      findings.push(
        finding(
          'package_data_loaded_but_not_bound',
          'error',
          rel,
          lineOf(text, loadMatch[0].index),
          `${rel} loads data rows but never uses readData(row, "..."). Data-driven generated specs must preserve row/column bindings instead of hardcoding values.`,
        ),
      );
    }
    for (const match of loadMatch) {
      const dataRel = dataFilePathFromSpec(text, rel, match[1]);
      const dataFull = path.join(root, dataRel);
      const rows = readJsonSafe(dataFull, null);
      if (!Array.isArray(rows)) {
        findings.push(
          finding(
            'package_data_rows_missing',
            'error',
            rel,
            lineOf(text, match.index),
            `Spec references data file ${dataRel}, but it is missing or not a JSON array.`,
          ),
        );
        continue;
      }
      for (const key of readKeys) {
        const missing = rows.some(
          (row) => !row || !row.fields || !Object.prototype.hasOwnProperty.call(row.fields, key),
        );
        if (missing) {
          findings.push(
            finding(
              'package_data_key_missing',
              'error',
              dataRel,
              1,
              `Data slice is missing readData(row, "${key}") used by ${rel}.`,
            ),
          );
        }
      }
      for (const row of rows) {
        const fields = (row && row.fields) || {};
        if (
          fields.searchProduct != null &&
          (fields.searchName == null || fields.expectedContainsProductName == null)
        ) {
          findings.push(
            finding(
              'package_data_alias_missing',
              'error',
              dataRel,
              1,
              'Search data row is missing canonical aliases searchName and expectedContainsProductName.',
            ),
          );
          break;
        }
      }
    }
  }
  return findings;
}

function discoverSeleniumTests(root, framework) {
  const fw = normalizeFramework(framework);
  const findings = [];
  const discovered = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.(java|feature)$/i.test(e.name)) {
        const rel = path.relative(root, full).replace(/\\/g, '/');
        const text = fs.readFileSync(full, 'utf8');
        if (/\.feature$/i.test(e.name) && /^\s*Scenario(?: Outline)?:/im.test(text))
          discovered.push({ rel, kind: 'feature' });
        if (/\.java$/i.test(e.name) && /@Test\b/.test(text))
          discovered.push({ rel, kind: 'testng' });
        if (/\.java$/i.test(e.name) && /extends\s+AbstractTestNGCucumberTests\b/.test(text))
          discovered.push({ rel, kind: 'cucumber-runner' });
        if (/\.java$/i.test(e.name) && /@(?:Given|When|Then|And|But)\s*\(/.test(text))
          discovered.push({ rel, kind: 'cucumber-step' });
      }
    }
  }
  walk(path.join(root, 'src'));

  if (SELENIUM_BDD_FRAMEWORKS.has(fw)) {
    if (!discovered.some((d) => d.kind === 'feature')) {
      findings.push(
        finding(
          'package_selenium_no_features',
          'error',
          null,
          1,
          'Selenium BDD package has no discoverable Gherkin scenarios.',
        ),
      );
    }
    if (!discovered.some((d) => d.kind === 'cucumber-runner')) {
      findings.push(
        finding(
          'package_selenium_no_cucumber_runner',
          'error',
          null,
          1,
          'Selenium BDD package has no TestNG Cucumber runner.',
        ),
      );
    }
    if (!discovered.some((d) => d.kind === 'cucumber-step')) {
      findings.push(
        finding(
          'package_selenium_no_step_definitions',
          'error',
          null,
          1,
          'Selenium BDD package has no Cucumber step definitions.',
        ),
      );
    }
  } else if (!discovered.some((d) => d.kind === 'testng')) {
    findings.push(
      finding(
        'package_selenium_no_testng_tests',
        'error',
        null,
        1,
        'Selenium package has no discoverable TestNG @Test methods.',
      ),
    );
  }

  return { discovered, findings };
}

async function validatePlaywrightPackage({
  framework,
  projectRoot,
  files,
  timeoutMs,
  dependencyPaths,
}) {
  const findings = [];
  const depPaths = [projectRoot, ...(dependencyPaths || [])];
  let cli = packageBin('@playwright/test', 'playwright', depPaths);
  if (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
    findings.push(
      finding(
        'package_playwright_no_package_json',
        'warning',
        'package.json',
        1,
        'Playwright package validation skipped: package.json is missing.',
      ),
    );
    return { checked: false, skipped: true, findings, commands: [] };
  }
  if (!cli) {
    findings.push(
      finding(
        'package_playwright_dependencies_missing',
        'warning',
        'package.json',
        1,
        'Playwright package validation skipped: @playwright/test is not installed in this package or validator environment.',
      ),
    );
    return { checked: false, skipped: true, findings, commands: [] };
  }

  const fw = normalizeFramework(framework);
  const scratch = makeScratch(projectRoot, files);
  const commands = [];
  try {
    // Mirror the Playwright runtime PLUS every dependency the GENERATED package.json
    // declares (e.g. dotenv, which the generated playwright.config requires at load).
    // Without this, `playwright test --list` throws MODULE_NOT_FOUND on a declared-but-
    // unmirrored dep → a spurious `package_playwright_collect_failed` that blocks an
    // otherwise-runnable export. Keyed off the export's OWN manifest — never a hardcoded
    // framework/site assumption. mirrorPackageIntoScratch no-ops on deps absent from the
    // validator env, so this can only ADD coverage, never break.
    const mirrorDeps = new Set(['@playwright/test', 'playwright', 'playwright-core']);
    try {
      const pkgRaw = files && (files['package.json'] || files['./package.json']);
      if (pkgRaw) {
        const pkg = JSON.parse(typeof pkgRaw === 'string' ? pkgRaw : JSON.stringify(pkgRaw || {}));
        for (const d of Object.keys({
          ...(pkg.dependencies || {}),
          ...(pkg.devDependencies || {}),
        }))
          mirrorDeps.add(d);
      }
    } catch (_) {
      /* fall back to the Playwright-only mirror set */
    }
    for (const dep of mirrorDeps) {
      mirrorPackageIntoScratch(dep, scratch, depPaths);
    }
    cli = packageBin('@playwright/test', 'playwright', [scratch, ...depPaths]) || cli;
    findings.push(...collectNpmManifestFindings(scratch));
    findings.push(...collectModuleClosureFindings(scratch));
    findings.push(...collectStaticPackageFindings(scratch, fw));

    if (PLAYWRIGHT_BDD_FRAMEWORKS.has(fw)) {
      const bddCli = packageBin('playwright-bdd', 'bddgen', [scratch, ...depPaths]);
      if (!bddCli) {
        findings.push(
          finding(
            'package_playwright_bdd_dependencies_missing',
            'warning',
            'package.json',
            1,
            'Playwright BDD collection skipped: playwright-bdd is not installed.',
          ),
        );
        return { checked: false, skipped: true, findings, commands };
      }
      const bdd = runNodeCli(bddCli, [], scratch, timeoutMs);
      commands.push({
        cmd: 'bddgen',
        status: bdd.status,
        output: commandOutput(bdd).slice(0, 2000),
      });
      if (bdd.status !== 0) {
        findings.push(
          finding(
            'package_playwright_bddgen_failed',
            'error',
            null,
            1,
            'playwright-bdd generation failed before collection.',
            commandOutput(bdd),
          ),
        );
        return { checked: true, skipped: false, findings, commands };
      }
    }

    const result = runNodeCli(cli, ['test', '--list'], scratch, timeoutMs);
    const output = commandOutput(result);
    commands.push({
      cmd: 'playwright test --list',
      status: result.status,
      output: output.slice(0, 2000),
    });
    if (result.error && result.error.code === 'ETIMEDOUT') {
      findings.push(
        finding(
          'package_playwright_collect_timeout',
          'error',
          null,
          1,
          `Playwright collection timed out after ${timeoutMs}ms.`,
          output,
        ),
      );
    } else if (result.status !== 0) {
      findings.push(
        finding(
          'package_playwright_collect_failed',
          'error',
          null,
          1,
          'Playwright could not collect the generated tests.',
          output,
        ),
      );
    } else if (countListedTests(output) === 0) {
      findings.push(
        finding(
          'package_playwright_no_tests_collected',
          'error',
          null,
          1,
          'Playwright collection succeeded but found zero tests.',
          output,
        ),
      );
    }
    return { checked: true, skipped: false, findings, commands };
  } finally {
    cleanupScratch(scratch);
  }
}

async function validateSeleniumPackage({ framework, projectRoot, files, timeoutMs }) {
  const findings = [];
  if (!fs.existsSync(path.join(projectRoot, 'pom.xml'))) {
    findings.push(
      finding(
        'package_selenium_no_pom',
        'warning',
        'pom.xml',
        1,
        'Maven package validation skipped: pom.xml is missing.',
      ),
    );
    return { checked: false, skipped: true, findings, commands: [] };
  }

  const scratch = makeScratch(projectRoot, files);
  const commands = [];
  try {
    const discovery = discoverSeleniumTests(scratch, framework);
    findings.push(...discovery.findings);

    const mvn = runMaven(['-o', '-q', '-DskipTests', 'test-compile'], scratch, timeoutMs);
    const output = commandOutput(mvn);
    commands.push({
      cmd: 'mvn -o -q -DskipTests test-compile',
      status: mvn.status,
      output: output.slice(0, 2000),
    });
    if (isCommandMissing(mvn)) {
      findings.push(
        finding(
          'package_maven_missing',
          'warning',
          'pom.xml',
          1,
          'Maven compile validation skipped: mvn is not available on PATH.',
        ),
      );
      return { checked: false, skipped: true, findings, commands };
    }
    if (mvn.error && mvn.error.code === 'ETIMEDOUT') {
      findings.push(
        finding(
          'package_maven_compile_timeout',
          'error',
          null,
          1,
          `Maven test-compile timed out after ${timeoutMs}ms.`,
          output,
        ),
      );
    } else if (mvn.status !== 0 && isMissingDependencyOutput(output)) {
      findings.push(
        finding(
          'package_maven_dependencies_missing',
          'warning',
          'pom.xml',
          1,
          'Maven compile skipped: required artifacts are not present in the local Maven repository for offline validation.',
          output,
        ),
      );
    } else if (mvn.status !== 0) {
      findings.push(
        finding(
          'package_maven_compile_failed',
          'error',
          null,
          1,
          'Maven test-compile failed for the generated Selenium package.',
          output,
        ),
      );
    }

    return { checked: true, skipped: false, findings, commands, discovered: discovery.discovered };
  } finally {
    cleanupScratch(scratch);
  }
}

async function validatePackage({
  framework,
  projectRoot,
  files = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  dependencyPaths = [],
} = {}) {
  const fw = normalizeFramework(framework);
  const root = projectRoot ? path.resolve(projectRoot) : null;
  const findings = [];
  let result = { checked: false, skipped: true, findings, commands: [] };

  if (!root || !fs.existsSync(root)) {
    findings.push(
      finding(
        'package_root_missing',
        'warning',
        null,
        1,
        'Package validation skipped: project root does not exist.',
      ),
    );
    result = { checked: false, skipped: true, findings, commands: [] };
  } else if (PLAYWRIGHT_FRAMEWORKS.has(fw)) {
    result = await validatePlaywrightPackage({
      framework: fw,
      projectRoot: root,
      files,
      timeoutMs,
      dependencyPaths,
    });
  } else if (SELENIUM_FRAMEWORKS.has(fw)) {
    result = await validateSeleniumPackage({
      framework: fw,
      projectRoot: root,
      files,
      timeoutMs,
      dependencyPaths,
    });
  } else {
    findings.push(
      finding(
        'package_unknown_framework',
        'warning',
        null,
        1,
        `Package validation skipped for unsupported framework "${framework}".`,
      ),
    );
    result = { checked: false, skipped: true, findings, commands: [] };
  }

  const allFindings = [...findings, ...(result.findings || [])];
  const errorCount = allFindings.filter((f) => f.severity === 'error').length;
  const warningCount = allFindings.filter((f) => f.severity === 'warning').length;
  return {
    packagePassed: errorCount === 0,
    checked: !!result.checked,
    skipped: !!result.skipped,
    findings: allFindings,
    errorCount,
    warningCount,
    commands: result.commands || [],
    discovered: result.discovered || [],
  };
}

module.exports = {
  validatePackage,
  collectNpmManifestFindings,
  collectModuleClosureFindings,
  discoverSeleniumTests,
  countListedTests,
  isMissingDependencyOutput,
  finding,
};
