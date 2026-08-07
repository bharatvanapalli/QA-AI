'use strict';

const { normalizeStepsInput } = require('./reliability/contracts');

/**
 * ExecutionReadinessCompiler — the START-STATE contract for a generated case.
 *
 * THE MISSING ARCHITECTURE. A case is not execution-ready just because its data
 * binding and assertions are valid. It is ready only if it has an EXECUTABLE
 * START-STATE contract: from the actual browser state the conductor starts in
 * (a FRESH, logged-OUT session for an independent scenario), the case's first
 * real action must be reachable.
 *
 * The gap this closes (live run e8307486): "Per-menu-item navigation" was
 * data/oracle-ready but its steps were only [Click left-menu link, Verify signal].
 * With no login/setup step and no dependency guaranteeing an authenticated session,
 * the conductor started on the login page and the approved step "Click left-menu
 * link" could never run — the agent tried to log in and strict-mode rejected it.
 *
 * This compiler enforces:
 *   start state → setup → action sequence
 * For every case that operates on AUTHENTICATED UI but does NOT already authenticate
 * itself, it COMPILES a self-contained login prelude (harvested from the proven login
 * sequence already present in the generation) into the front of the case's steps, and
 * attaches the credential binding so the injected {{username}}/{{password}} tokens
 * resolve per row (via the profileKey -> profiles-sheet companion join). A case that
 * needs auth but for which NO login template / credentials exist is NOT
 * execution-ready and is reported so the caller drops it (never fabricate auth).
 *
 * PURE (no DB / LLM / IO). Generic across any site/workbook — keyed on login-page /
 * credential-field / profileKey SHAPE, never a site value. The one-time repair of an
 * already-persisted generation lives in scripts/repair_execution_readiness.cjs and
 * reuses these exact functions.
 */

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');

function decodeDeps(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (!raw || typeof raw !== 'string') return [];
  try {
    const decoded = JSON.parse(raw);
    return Array.isArray(decoded) ? decoded.filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function decodeSteps(steps) {
  const result = normalizeStepsInput(steps, { allowSingletonObject: false });
  return result.ok ? result.steps : [];
}
function stepText(s) {
  return [s && s.action, s && s.target, s && s.element, s && s.locator_hint, s && s.value]
    .filter((v) => v != null).join(' ').toLowerCase();
}
const isFillLike = (s) => /\b(fill|type|enter|input)\b/.test(String((s && s.action) || '').toLowerCase());
const isClickLike = (s) => /\b(click|press|tap|submit)\b/.test(String((s && s.action) || '').toLowerCase());
const mentionsPassword = (s) => /\bpassword\b/.test(stepText(s));
const mentionsUsername = (s) => /\b(user\s?name|username|email|login\s?id)\b/.test(stepText(s));
const mentionsLoginControl = (s) => /\b(log\s?in|sign\s?in|log-in|sign-in)\b/.test(stepText(s));
const mentionsLoginPage = (s) => /\b(login|sign\s?in|auth\/login|credential)\b/.test(stepText(s));
function caseLooksLikeLoginFlow(caseObj) {
  const text = `${caseObj && (caseObj.name || '')} ${caseObj && (caseObj.module || '')} ${caseObj && (caseObj.caseIntent || '')}`.toLowerCase();
  return /\b(login|sign\s?in|authentication|auth|credential)\b/.test(text);
}

/**
 * Does the case ALREADY authenticate itself? True when the first handful of steps
 * contain a credential fill (password) AND a login submit — i.e. it self-logs-in
 * (the login scenario itself, and every negative-login test, look like this, so
 * they are correctly left untouched).
 */
function caseHasLoginSetup(caseObj) {
  const steps = decodeSteps(caseObj && caseObj.steps).slice(0, 6);
  const hasUser = steps.some((s) => isFillLike(s) && mentionsUsername(s));
  const hasPwd = steps.some((s) => isFillLike(s) && mentionsPassword(s));
  const hasSubmit = steps.some((s) => isClickLike(s) && mentionsLoginControl(s));
  const hasLoginContext = steps.some(mentionsLoginPage) || caseLooksLikeLoginFlow(caseObj);
  return hasUser && hasPwd && hasSubmit && hasLoginContext;
}

/** The profileKey/role a data-driven case runs AS (the auth identity), if declared. */
function caseProfileRoleColumn(binding) {
  const c2f = (binding && binding.columnToField && typeof binding.columnToField === 'object') ? binding.columnToField : {};
  // role/profile token → the sheet column that names the auth profile.
  for (const role of ['role', 'profilekey', 'profile', 'authrole']) {
    if (c2f[role]) return c2f[role];
  }
  // or a column literally named profileKey/role.
  for (const [, header] of Object.entries(c2f)) {
    if (/^(profilekey|role|authrole)$/i.test(String(header).replace(/[^a-z0-9]/gi, ''))) return header;
  }
  return null;
}

const AUTH_UI_RE = /\b(left[\s-]?menu|side\s?menu|nav(?:igation)?\s?(?:link|menu|bar)|dashboard|module|quick\s?launch|top\s?bar|header\s?menu|breadcrumb|admin|pim|leave|recruitment|directory|maintenance|buzz|my\s?info|performance|claim|time\s?sheet)\b/i;

/**
 * Does this case operate on AUTHENTICATED UI (so it needs a logged-in start state)?
 * Signals, in priority: (1) it runs AS a profile/role (profileKey binding) - the
 * workbook's own "login at the start of every story" contract; (2) a credential
 * companion is attached; (3) its steps target authenticated-only chrome (menu /
 * module / dashboard); (4) its module is not the auth/login module. A self-logging-in
 * case is never flagged (handled by caseHasLoginSetup upstream).
 */
function caseNeedsAuth(caseObj, binding) {
  if (caseProfileRoleColumn(binding)) return true;
  if (binding && Array.isArray(binding.companions) && binding.companions.some((c) => c && /credential|auth|profile/i.test(String(c.source || c.sheet || '')))) return true;
  const steps = decodeSteps(caseObj && caseObj.steps);
  if (steps.some((s) => AUTH_UI_RE.test(stepText(s)))) return true;
  const mod = norm(caseObj && caseObj.module);
  if (mod && !/^(authentication|login|auth|signin|signup|register|public)$/.test(mod)) {
    // A module case that is not itself an auth/public flow assumes a logged-in app.
    // Require at least one action step (not a pure static doc case) to avoid tagging
    // non-UI cases.
    if (steps.some((s) => isClickLike(s) || isFillLike(s) || /\b(verify|navigate|open|go to)\b/i.test(String(s.action || '')))) return true;
  }
  return false;
}

/**
 * Harvest the proven login PRELUDE from the generation: the ordered steps that a
 * self-authenticating case uses to log in (navigate-to-login → fill username → fill
 * password → click login), stopping BEFORE the first post-login/functional step, plus
 * the credential binding that makes those tokens resolve (the profiles sheet + the
 * username/password column mapping). Returns null when no login case exists.
 */
function harvestLoginTemplate(scenarios) {
  const cases = [];
  for (const scn of (Array.isArray(scenarios) ? scenarios : [])) {
    for (const c of (Array.isArray(scn && scn.cases) ? scn.cases : [])) if (c) cases.push(c);
  }
  // Prefer a POSITIVE login case (reaches dashboard, valid creds) — never a negative
  // one (it fills wrong credentials on purpose).
  const looksNegative = (c) => /invalid|wrong|incorrect|empty|blank|locked|reject|fail|negative|lockout/i.test(`${c.name || ''} ${c.assertions || ''}`);
  const candidates = cases.filter((c) => caseLooksLikeLoginFlow(c) && caseHasLoginSetup(c) && !looksNegative(c));
  const login = candidates[0] || cases.filter((c) => caseHasLoginSetup(c))[0] || null;
  if (!login) return null;

  const steps = decodeSteps(login.steps);
  // The prelude = every leading step up to AND INCLUDING the login-submit click. Stop
  // at the first step after the submit (that is the functional/verify part).
  const prelude = [];
  let sawSubmit = false;
  for (const s of steps) {
    prelude.push(s);
    if (isClickLike(s) && mentionsLoginControl(s)) { sawSubmit = true; break; }
    // Fallback: if a case has no explicit "login" click label, stop after the password
    // fill + the next click.
    if (sawSubmit) break;
  }
  if (!sawSubmit) {
    // No labelled login submit — take up to the password fill + one following click.
    return null;
  }
  if (!prelude.length) return null;

  // Credential binding: the login case's companion (profiles sheet + column map), or,
  // when the login case is bound DIRECTLY to a profiles sheet, that sheet + a
  // username/password column map derived from it.
  const b = (login.dataBinding && typeof login.dataBinding === 'object') ? login.dataBinding
    : (() => { try { return JSON.parse(login.dataBindingJson || 'null'); } catch { return null; } })();
  let credCompanion = null;
  if (b && Array.isArray(b.companions)) credCompanion = b.companions.find((c) => c && c.columnToField && (c.columnToField.username || c.columnToField.loginusername || c.columnToField.loginpassword)) || null;
  let credSheet = credCompanion ? credCompanion.sheet : (b && b.sheet) || null;
  let credColumnToField = credCompanion ? credCompanion.columnToField : (b && b.columnToField) || null;

  return {
    sourceCase: login.name || null,
    prelude: prelude.map((s) => ({ ...s })),
    credSheet: credSheet || null,
    credColumnToField: credColumnToField || null,
    companion: credCompanion || (credSheet ? { sheet: credSheet, columnToField: credColumnToField || {}, source: 'credential_companion' } : null),
  };
}

function renumber(steps) {
  return steps.map((s, i) => (s && typeof s === 'object' ? { ...s, order: i + 1 } : s));
}

/**
 * Return the case's FUNCTIONAL steps with a leading login prelude removed — used by the
 * conductor's "login once per profile" scheduling: when the session is already
 * authenticated for a row's profile, the injected/authored login prelude must NOT run
 * again (it would navigate to /login on an authenticated app, where the login form no
 * longer exists, and fail). Only strips when the steps ACTUALLY start with a login
 * sequence (a leading password fill), and never strips everything (a login-only case
 * keeps its steps). Generic — keyed on the login-step SHAPE, never a site value.
 */
function stripLoginPrelude(steps) {
  const arr = decodeSteps(steps);
  if (!arr.length) return arr;
  const head = arr.slice(0, 6);
  if (!head.some((s) => isFillLike(s) && mentionsPassword(s))) return arr; // not a login-led case
  let cut = arr.findIndex((s) => isClickLike(s) && mentionsLoginControl(s));
  if (cut === -1) return arr;
  const rest = arr.slice(cut + 1);
  return renumber(rest.length ? rest : arr); // never strip to nothing
}

/**
 * Repair ONE case's start-state contract IN PLACE. Returns
 *   { changed, executable, reason }
 * executable=false means the case needs auth but could not be made runnable (no login
 * template / no credentials) → the caller must NOT persist it.
 */
function repairCaseExecutionReadiness(caseObj, binding, loginTemplate) {
  if (!caseObj) return { changed: false, executable: true, reason: 'no_case' };
  if (String(caseObj.automatability || 'automatable') === 'manual') return { changed: false, executable: true, reason: 'manual' };

  const needsAuth = caseNeedsAuth(caseObj, binding);
  if (!needsAuth) { caseObj._execReadiness = 'no_setup_required'; return { changed: false, executable: true, reason: 'no_auth_needed' }; }
  if (
    String(caseObj.sessionMode || '').trim() === 'continue_from_dependency'
    && decodeDeps(caseObj.dependsOnIds).length
  ) {
    caseObj._execReadiness = 'dependency_session';
    return { changed: false, executable: true, reason: 'dependency_session' };
  }
  if (caseHasLoginSetup(caseObj)) { caseObj._execReadiness = 'self_authenticates'; return { changed: false, executable: true, reason: 'self_auth' }; }

  // Needs auth but does not self-authenticate → must inject the compiled login prelude.
  if (!loginTemplate || !loginTemplate.prelude || !loginTemplate.prelude.length) {
    caseObj._execReadiness = 'needs_auth_setup';
    caseObj.authSetupPlan = {
      kind: 'login',
      status: 'needs_app_clarification',
      reason: 'no_login_template',
      steps: [],
      credentials: [],
      capabilityEvidence: [],
    };
    return { changed: true, executable: true, reason: 'needs_auth_setup' };
  }
  if (!loginTemplate.companion && !loginTemplate.credColumnToField) {
    caseObj._execReadiness = 'needs_auth_credentials';
    caseObj.authSetupPlan = {
      kind: 'login',
      status: 'needs_data_choice',
      reason: 'no_credentials',
      steps: Array.isArray(loginTemplate.prelude) ? loginTemplate.prelude.map((s) => ({ ...s })) : [],
      credentials: [],
      capabilityEvidence: [],
    };
    return { changed: true, executable: true, reason: 'needs_auth_credentials' };
  }

  // 1) Prepend the login prelude to the case's steps.
  const original = decodeSteps(caseObj.steps);
  const merged = renumber([...loginTemplate.prelude.map((s) => ({ ...s })), ...original]);
  caseObj.steps = merged;

  // 2) Make the injected {{username}}/{{password}} resolve. The prelude tokens come
  //    from the login template; attach the credential source to THIS case's binding.
  let b = binding || (caseObj.dataBinding && typeof caseObj.dataBinding === 'object' ? caseObj.dataBinding : null);
  if (b && caseProfileRoleColumn(b)) {
    // Data-driven case that runs AS a profile: attach the credential COMPANION so the
    // profileKey -> profiles join fills username/password per row.
    b.companions = Array.isArray(b.companions) ? b.companions : [];
    const already = b.companions.some((c) => c && norm(c.sheet) === norm(loginTemplate.companion && loginTemplate.companion.sheet));
    if (!already && loginTemplate.companion) b.companions.push({ ...loginTemplate.companion });
    caseObj.dataBinding = b;
  } else {
    // No profile-bearing binding (e.g. a cleared static/product-gap case). Bind directly
    // to the profiles sheet so the login resolves; the functional assertion is static.
    if (loginTemplate.credSheet) {
      caseObj.dataBinding = {
        sheet: loginTemplate.credSheet,
        rowSelector: 'all',
        columnToField: loginTemplate.credColumnToField || (loginTemplate.companion && loginTemplate.companion.columnToField) || {},
        status: 'complete',
        source: 'execution_readiness_login_setup',
        ...(b ? { _priorBinding: b } : {}),
      };
    }
  }

  caseObj._execReadiness = 'login_setup_injected';
  return { changed: true, executable: true, reason: 'login_setup_injected' };
}

/**
 * Compile execution-readiness across a set of scenarios (mutated in place). Cases that
 * cannot be made executable are removed and reported.
 *
 * @returns {{ scenarios, report }}
 *   report = { total, injected, selfAuth, noSetupNeeded, dropped[], loginTemplateSource }
 */
function compileExecutionReadiness({ scenarios = [], loginTemplate = undefined } = {}) {
  const tmpl = loginTemplate === undefined ? harvestLoginTemplate(scenarios) : loginTemplate;
  const report = { total: 0, injected: 0, selfAuth: 0, noSetupNeeded: 0, needsAuthSetup: [], dropped: [], loginTemplateSource: tmpl && tmpl.sourceCase ? tmpl.sourceCase : null };
  const out = [];
  for (const scn of (Array.isArray(scenarios) ? scenarios : [])) {
    const keep = [];
    for (const c of (Array.isArray(scn && scn.cases) ? scn.cases : [])) {
      if (!c || typeof c !== 'object') continue;
      report.total += 1;
      const binding = (c.dataBinding && typeof c.dataBinding === 'object') ? c.dataBinding
        : (() => { try { return JSON.parse(c.dataBindingJson || 'null'); } catch { return null; } })();
      const res = repairCaseExecutionReadiness(c, binding, tmpl);
      if (!res.executable) { report.dropped.push({ case: c.name, reason: res.reason }); continue; }
      if (res.reason === 'login_setup_injected') report.injected += 1;
      else if (res.reason === 'self_auth') report.selfAuth += 1;
      else if (res.reason === 'needs_auth_setup' || res.reason === 'needs_auth_credentials') {
        report.needsAuthSetup.push({ case: c.name, reason: res.reason });
      } else report.noSetupNeeded += 1;
      keep.push(c);
    }
    if (keep.length) out.push({ ...scn, cases: keep });
  }
  return { scenarios: out, report };
}

module.exports = {
  compileExecutionReadiness,
  repairCaseExecutionReadiness,
  harvestLoginTemplate,
  caseNeedsAuth,
  caseHasLoginSetup,
  caseProfileRoleColumn,
  stripLoginPrelude,
};
