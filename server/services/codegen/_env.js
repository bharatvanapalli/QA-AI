'use strict';

/**
 * Canonical credential / environment contract — shared by EVERY codegen
 * framework (Playwright TS, Playwright JS, Playwright BDD, Selenium, Selenium
 * BDD).
 *
 * WHY THIS EXISTS
 * Before this module, each test case was authored by an INDEPENDENT codegen
 * LLM call, and each call invented its own credential env-var names. A single
 * A large export referenced many different names — QAAI_USERNAME,
 * OHR_USERNAME, ORANGEHRM_USERNAME, ORANGEHRM_USER, OHR_ADMIN_USER, … none of
 * which were ever set, and two of which fell back to '' (empty) so the login
 * form was submitted blank and the case failed. There was no .env, no single
 * accessor, no consistency.
 *
 * THE CONTRACT
 * One scheme, used by all frameworks and all cases:
 *   - Primary user  → QAAI_USERNAME / QAAI_PASSWORD
 *   - Extra users   → QAAI_USER2_USERNAME / QAAI_USER2_PASSWORD, …
 *   - Base URL      → QAAI_TARGET_URL (already used by the project shells)
 * The project shell emits BOTH a real `.env` (gitignored, with the project's
 * configured/observed credentials baked in so the suite runs with zero setup)
 * AND a committed `.env.example`. The per-language accessor (utils/env.ts /
 * utils/env.js / Java Config) reads `process.env.<NAME>` with the REAL value as
 * the fallback — never '' — so a deleted .env degrades to a working default
 * instead of a blank login.
 *
 * The credential profile is built from, in order of trust:
 *   1. project.testCredentials (the operator's configured users) — authoritative
 *   2. credentials observed in the run's action trail (what actually logged in)
 *   3. nothing → a clearly-marked placeholder profile (no creds; login helper
 *      still emitted but reads env with a CHANGE_ME default + a console note)
 */

const PRIMARY_USER_ENV = 'QAAI_USERNAME';
const PRIMARY_PASS_ENV = 'QAAI_PASSWORD';

// Parse the project.testCredentials column (JSON string array of
// {name,email,password,notes}) OR an already-parsed array. The "email" field
// holds whatever the login form's first field wants — often the
// username "Admin", not an email address — so we treat it as the username.
function parseStoredCredentials(testCredentials) {
  let arr = testCredentials;
  if (typeof testCredentials === 'string') {
    try { arr = JSON.parse(testCredentials); } catch (_) { arr = null; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((u) => u && (u.email || u.username) && u.password)
    .map((u) => ({
      username: String(u.email || u.username),
      password: String(u.password),
      name: u.name ? String(u.name) : '',
    }));
}

function envNamesForIndex(i) {
  return i === 0
    ? { userEnv: PRIMARY_USER_ENV, passEnv: PRIMARY_PASS_ENV }
    : { userEnv: `QAAI_USER${i + 1}_USERNAME`, passEnv: `QAAI_USER${i + 1}_PASSWORD` };
}

/**
 * Build the canonical credential profile.
 * @param {object} opts
 * @param {string|Array} [opts.testCredentials]  project.testCredentials
 * @param {{username,password,name}} [opts.observed]  credentials observed in the
 *        action trail (used only when testCredentials is empty)
 * @returns {{ users: Array<{username,password,name,userEnv,passEnv}>, hasCreds: boolean }}
 */
function buildCredentialProfile({ testCredentials, observed } = {}) {
  let users = parseStoredCredentials(testCredentials);
  if (users.length === 0 && observed && observed.username) {
    users = [{ username: String(observed.username), password: String(observed.password || ''), name: observed.name || 'default' }];
  }
  const mapped = users.map((u, i) => ({ ...u, ...envNamesForIndex(i) }));
  return { users: mapped, hasCreds: mapped.length > 0 };
}

// The primary user, or a clearly-marked placeholder when none is known.
function primary(profile) {
  return profile.users[0] || {
    username: 'CHANGE_ME_USERNAME',
    password: 'CHANGE_ME_PASSWORD',
    name: 'default',
    userEnv: PRIMARY_USER_ENV,
    passEnv: PRIMARY_PASS_ENV,
  };
}

// Shell-safe single-line value for a dotenv file (no surrounding quotes; dotenv
// treats the rest of the line as the value). Strip newlines defensively.
function dotenvValue(v) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ');
}

function renderDotenv(profile, { targetUrl } = {}) {
  const lines = [
    '# QAAI generated environment — real values, gitignored.',
    '# The suite reads these; override per-environment without editing code.',
    '',
  ];
  if (targetUrl) lines.push(`QAAI_TARGET_URL=${dotenvValue(targetUrl)}`, '');
  if (profile.hasCreds) {
    for (const u of profile.users) {
      if (u.name) lines.push(`# ${u.name}`);
      lines.push(`${u.userEnv}=${dotenvValue(u.username)}`);
      lines.push(`${u.passEnv}=${dotenvValue(u.password)}`);
      lines.push('');
    }
  } else {
    lines.push('# No credentials were configured for this project — set these before running auth flows.');
    lines.push(`${PRIMARY_USER_ENV}=`);
    lines.push(`${PRIMARY_PASS_ENV}=`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderDotenvExample(profile, { targetUrl } = {}) {
  const lines = [
    '# Copy to .env and fill in. QAAI bakes a working .env for you on export;',
    '# this committed example documents the contract.',
    '',
  ];
  if (targetUrl) lines.push('QAAI_TARGET_URL=https://your-app.example.com', '');
  const users = profile.hasCreds ? profile.users : [{ ...primary(profile) }];
  for (const u of users) {
    if (u.name) lines.push(`# ${u.name}`);
    lines.push(`${u.userEnv}=`);
    lines.push(`${u.passEnv}=`);
    lines.push('');
  }
  return lines.join('\n');
}

// utils/env.ts — TypeScript accessor with the REAL value baked as the fallback.
function renderEnvAccessorTs(profile, { baseUrl } = {}) {
  const p = primary(profile);
  const extra = profile.users.slice(1).map((u) =>
    `export const ${u.userEnv} = process.env.${u.userEnv} ?? ${JSON.stringify(u.username)};\n` +
    `export const ${u.passEnv} = process.env.${u.passEnv} ?? ${JSON.stringify(u.password)};`).join('\n');
  return `/**
 * Centralised, type-safe access to test data. ONE credential contract for the
 * whole suite — never invent per-test env-var names. Values fall back to the
 * project's configured credentials so the suite runs with zero setup; override
 * via .env / real environment variables for other environments.
 */
export const QAAI_TARGET_URL = process.env.QAAI_TARGET_URL ?? ${JSON.stringify(baseUrl || '')};

// Primary test user
export const ${p.userEnv} = process.env.${p.userEnv} ?? ${JSON.stringify(p.username)};
export const ${p.passEnv} = process.env.${p.passEnv} ?? ${JSON.stringify(p.password)};
${extra ? '\n// Additional users\n' + extra + '\n' : ''}`;
}

// utils/env.js — CommonJS sibling of the TS accessor.
function renderEnvAccessorJs(profile, { baseUrl } = {}) {
  const p = primary(profile);
  const entries = [
    `  QAAI_TARGET_URL: process.env.QAAI_TARGET_URL || ${JSON.stringify(baseUrl || '')},`,
    `  ${p.userEnv}: process.env.${p.userEnv} || ${JSON.stringify(p.username)},`,
    `  ${p.passEnv}: process.env.${p.passEnv} || ${JSON.stringify(p.password)},`,
    ...profile.users.slice(1).flatMap((u) => [
      `  ${u.userEnv}: process.env.${u.userEnv} || ${JSON.stringify(u.username)},`,
      `  ${u.passEnv}: process.env.${u.passEnv} || ${JSON.stringify(u.password)},`,
    ]),
  ];
  return `/**
 * Centralised access to test data. ONE credential contract for the whole suite.
 * Values fall back to the project's configured credentials so the suite runs
 * with zero setup; override via .env / real environment variables.
 */
module.exports = {
${entries.join('\n')}
};
`;
}

// Java config reader (Selenium): src/main/java/com/qaai/util/Config.java.
function renderJavaConfig(profile, basePackage, { baseUrl } = {}) {
  const p = primary(profile);
  const getter = (env, val) =>
    `        String v = System.getenv("${env}");\n` +
    `        return (v != null && !v.isEmpty()) ? v : ${JSON.stringify(val)};`;
  return `package ${basePackage}.util;

/**
 * One credential contract for the whole suite. Reads QAAI_* environment
 * variables, falling back to the project's configured values so the suite runs
 * with no setup. Override via real environment variables for other envs.
 */
public final class Config {
    private Config() { }

    public static String baseUrl() {
        String sys = System.getProperty("qaai.targetUrl");
        if (sys != null && !sys.isEmpty()) return sys;
${getter('QAAI_TARGET_URL', baseUrl || '')}
    }

    public static String username() {
${getter(p.userEnv, p.username)}
    }

    public static String password() {
${getter(p.passEnv, p.password)}
    }
}
`;
}

/**
 * The instruction block injected into a codegen prompt so the model uses the
 * shared accessor and the exact env-var names — never invents its own.
 * @param {string} lang  'ts' | 'js' | 'java'
 * @param {string} accessorImportPath  e.g. '../../utils/env'
 */
function promptBlock(profile, { lang = 'ts', accessorImportPath = '../../utils/env' } = {}) {
  const p = primary(profile);
  if (lang === 'java') {
    return `## CREDENTIALS — use the shared contract ONLY
- Read credentials from com.qaai.util.Config: Config.username() and Config.password(). Base URL via Config.baseUrl().
- NEVER read System.getenv with an invented variable name. NEVER hardcode credentials. NEVER use an empty-string fallback.
- The primary test user is "${p.name || 'default'}".`;
  }
  if (lang === 'js') {
    return `## CREDENTIALS — use the shared contract ONLY
- Import the shared env module: const { ${p.userEnv}, ${p.passEnv} } = require('${accessorImportPath}');
- Use ${p.userEnv} / ${p.passEnv} for login. Base URL is configured in playwright.config.js — use relative goto('/path').
- NEVER write process.env.<SOMETHING> directly in a test. NEVER invent env-var names. NEVER use a ?? '' / || '' empty fallback (that submits a blank login).
- The primary test user is "${p.name || 'default'}".`;
  }
  return `## CREDENTIALS — use the shared contract ONLY
- Import the shared env module: import { ${p.userEnv}, ${p.passEnv} } from '${accessorImportPath}';
- Use ${p.userEnv} / ${p.passEnv} for login. Base URL is configured in playwright.config.ts — use relative page.goto('/path').
- NEVER write process.env.<SOMETHING> directly in a test. NEVER invent env-var names. NEVER use a ?? '' / || '' empty fallback (that submits a blank login).
- The primary test user is "${p.name || 'default'}".`;
}

module.exports = {
  PRIMARY_USER_ENV,
  PRIMARY_PASS_ENV,
  parseStoredCredentials,
  buildCredentialProfile,
  primary,
  renderDotenv,
  renderDotenvExample,
  renderEnvAccessorTs,
  renderEnvAccessorJs,
  renderJavaConfig,
  promptBlock,
};
