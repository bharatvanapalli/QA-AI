'use strict';
/**
 * THE EXPORT CHECKPOINT.
 *
 * Every generated source file that reaches a user — rendered in the Output
 * Files tab OR packed into the download ZIP — passes through certifyFile()
 * exactly once, right before it is finalized. Both surfaces call it via the
 * shared buildReplayExport() assembly, so they cannot diverge.
 *
 * It does two things, in order:
 *   1. sanitizeGenerated()  — deterministic mechanical repair (dedupes imports,
 *      wraps bare page.evaluate, neutralizes descriptor locators, etc.).
 *   2. AST parse            — confirms the repaired source actually PARSES as
 *      JS/TS. A file that does not parse can never run; we refuse to ship one
 *      silently. The same @babel/parser the AST lint engine uses, so
 *      "parses here" == "parses in lintGates".
 *
 * Returns { content, parseOk, parseError, findings }. The caller turns a
 * parse failure into an error-severity finding that flips exportValid=false
 * and is surfaced in the UI + EXPORT_MANIFEST.json, instead of letting an
 * un-loadable file masquerade as a clean export.
 *
 * Pure except for require()s — no fs, no network.
 */
const parser = require('@babel/parser');
const { sanitizeGeneratedDetailed } = require('./_sanitize');

// Mirrors server/lib/specAst.js parseSpec so a file that passes here also
// passes the AST lint engine. errorRecovery:false so syntax errors THROW
// (errorRecovery:true would swallow them and hide the very failures we gate on).
const PARSE_OPTS = {
  sourceType: 'module',
  errorRecovery: false,
  allowImportExportEverywhere: true,
  plugins: ['typescript', 'jsx', 'objectRestSpread', 'optionalChaining', 'nullishCoalescingOperator', 'topLevelAwait'],
};

function isJsTsPath(relPath) {
  return /\.(c|m)?[jt]sx?$/.test(relPath || '');
}

/**
 * @param {object} o
 * @param {string} o.relPath   Bundle-relative path (decides extension handling).
 * @param {string} o.content   Raw generated source.
 * @param {boolean} [o.sanitize=true]  Run the mechanical sanitizer first.
 * @returns {{ content:string, parseOk:boolean, parseError:(string|null), findings:Array }}
 */
function certifyFile({ relPath = '', content, sanitize = true } = {}) {
  const findings = [];
  let out = typeof content === 'string' ? content : '';
  let rewrites = [];

  if (sanitize) {
    try {
      const detailed = sanitizeGeneratedDetailed(out, relPath);
      out = detailed.code;
      rewrites = detailed.rewrites;
    }
    catch (err) { findings.push({ rule: 'sanitize_threw', severity: 'warning', path: relPath, message: `sanitizer threw: ${err && err.message}` }); }
  }

  // Only JS/TS sources are AST-parseable; .feature/.json/.env/.md pass through.
  const isJsTs = relPath ? isJsTsPath(relPath) : /\b(?:test|expect|page)\b/.test(out);
  let parseOk = true;
  let parseError = null;
  if (isJsTs && out.trim()) {
    try {
      parser.parse(out, PARSE_OPTS);
    } catch (err) {
      parseOk = false;
      parseError = err && err.message ? String(err.message) : 'parse failed';
      findings.push({
        rule: 'spec_parse_error',
        severity: 'error',
        path: relPath,
        line: (err && err.loc && err.loc.line) || 1,
        message: `Generated file does not parse as JS/TS and will not run: ${parseError}`,
      });
    }
  }

  return { content: out, parseOk, parseError, findings, rewrites };
}

function parseTypeScriptDiagnostics(diagnostics) {
  const text = String(diagnostics || '');
  const out = [];
  const patterns = [
    /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm,
    /^(.+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s+(.+)$/gm,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      out.push({
        file: m[1],
        line: Number(m[2] || 1),
        col: Number(m[3] || 1),
        code: m[4],
        message: m[5] || '',
      });
    }
  }
  return out;
}

function normalisePathForDiag(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function fileKeyForDiagnostic(files, diagnosticPath) {
  const needle = normalisePathForDiag(diagnosticPath);
  const keys = Object.keys(files || {});
  return keys.find((k) => {
    const key = normalisePathForDiag(k);
    return needle === key || needle.endsWith(`/${key}`) || key.endsWith(`/${needle}`);
  }) || null;
}

function wrapNullableStringExpression(expr) {
  const raw = String(expr || '');
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^['"`]/.test(trimmed)) return null;
  if (/^(true|false|null|undefined|\d+(?:\.\d+)?)$/.test(trimmed)) return null;
  if (/\?\?|\|\||\bas\s+string\b|\bString\s*\(/.test(trimmed)) return null;
  if (/[;{}]/.test(trimmed) || /=>/.test(trimmed)) return null;
  return `((${trimmed}) ?? '')`;
}

function replaceNullableArg(line, pattern) {
  let changed = false;
  const next = String(line || '').replace(pattern, (m, before, expr, after) => {
    if (changed) return m;
    const wrapped = wrapNullableStringExpression(expr);
    if (!wrapped) return m;
    changed = true;
    return `${before}${wrapped}${after}`;
  });
  return changed ? next : null;
}

function repairStringNullDiagnosticLine(line) {
  const patterns = [
    /(assertTextPresent\(\s*[^,\n]+,\s*)([^,\n]+)(\s*,)/,
    /(assertTextAbsent\(\s*[^,\n]+,\s*)([^,\n]+)(\s*,)/,
    /(\b(?:page|locator|this\.\w+|[A-Za-z_$][\w$]*)\.getByText\(\s*)([^,\n)]+)(\s*,|\))/,
    /(\b(?:expect|this\.\w+|[A-Za-z_$][\w$]*)\.toHaveText\(\s*)([^,\n)]+)(\s*,|\))/,
    /(\b(?:page|locator|this\.\w+|[A-Za-z_$][\w$]*)\.goto\(\s*)([^,\n)]+)(\s*,|\))/,
    /(\bsafeGoto\(\s*[^,\n]+,\s*)([^,\n)]+)(\s*,|\))/,
    /(\b(?:page|locator|this\.\w+|[A-Za-z_$][\w$]*)\.fill\(\s*)([^,\n)]+)(\s*,|\))/,
    /(\b(?:page|locator|this\.\w+|[A-Za-z_$][\w$]*)\.waitForURL\(\s*)([^,\n)]+)(\s*,|\))/,
    /(\bnew\s+RegExp\(\s*)([^,\n)]+)(\s*,|\))/,
    /(\bname:\s*)([^,}\n]+)(\s*[,}])/,
    /(:\s*string\s*=\s*)([^;\n]+)(;)/,
  ];
  for (const pattern of patterns) {
    const repaired = replaceNullableArg(line, pattern);
    if (repaired) return repaired;
  }
  return null;
}

function repairMissingPropertyDiagnosticLine(line, property) {
  const prop = String(property || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!prop) return null;
  const unsafeRoots = new Set(['page', 'expect', 'test', 'this', 'console', 'process', 'import', 'Math', 'Date', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON']);
  const re = new RegExp(`\\b([A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*)\\s*\\.\\s*${prop}\\b`);
  let changed = false;
  const next = String(line || '').replace(re, (m, receiver) => {
    if (changed) return m;
    const root = String(receiver || '').split('.')[0].trim();
    if (unsafeRoots.has(root) || /\bas\s+any\b/.test(receiver)) return m;
    changed = true;
    return `(${receiver.replace(/\s+/g, '')} as any).${property} /* QAAI_TS_REPAIR_TS2339: verify generated object shape */`;
  });
  return changed ? next : null;
}

function repairTypeScriptDiagnostics(files, diagnostics) {
  const nextFiles = { ...(files || {}) };
  const repairs = [];
  const parsed = parseTypeScriptDiagnostics(diagnostics);
  for (const diag of parsed) {
    const relPath = fileKeyForDiagnostic(nextFiles, diag.file);
    if (!relPath || typeof nextFiles[relPath] !== 'string') continue;
    const lines = nextFiles[relPath].split(/\r?\n/);
    const idx = Math.max(0, (diag.line || 1) - 1);
    const before = lines[idx] || '';
    let after = null;
    let rule = null;
    if ((diag.code === 'TS2345' || diag.code === 'TS2322') && /string\s*\|\s*null/i.test(diag.message) && /string/i.test(diag.message)) {
      after = repairStringNullDiagnosticLine(before);
      rule = 'ts_string_null_to_empty_string_guard';
    } else if (diag.code === 'TS2339') {
      const prop = /Property\s+'([^']+)'/.exec(diag.message)?.[1] || null;
      after = repairMissingPropertyDiagnosticLine(before, prop);
      rule = 'ts_missing_property_any_cast';
    }
    if (!after || after === before) continue;
    lines[idx] = after;
    nextFiles[relPath] = lines.join('\n');
    repairs.push({
      relPath,
      line: diag.line,
      code: diag.code,
      rule,
      before: before.trim(),
      after: after.trim(),
    });
  }
  return { files: nextFiles, repairs };
}

module.exports = { certifyFile, isJsTsPath, repairTypeScriptDiagnostics };
