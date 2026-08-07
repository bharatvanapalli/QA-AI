'use strict';
/**
 * Pre-run DATA-ROW CONTRACT validation (site-INDEPENDENT, structural).
 *
 * A data-driven row whose CLASS/intent contradicts its OWN values is a test-data
 * defect, not a website behaviour — it must be blocked BEFORE the browser opens
 * (the reviewer's case: a row classed "emptyPassword" that nonetheless supplies
 * a non-empty password value). We flag:
 *   - a class/label that says an "empty <field>" but the row supplies a non-empty
 *     value for that field;
 *   - shouldSubmit/submit = no/false while the row supplies all the values a submit
 *     would need (a row that says "don't submit" but is shaped to submit);
 *   - a NEGATIVE-intent row (invalid/wrong/rejected/…) whose username AND password
 *     match the KNOWN-VALID credential profile when one is supplied via
 *     opts.knownValidCreds — you cannot test a rejection with valid credentials.
 *   - a CASE-vs-ROW intent mismatch: the CASE's oracle expects a NEGATIVE outcome
 *     (remain on login / required-field error / rejected credentials) but THIS row's
 *     data is a SUCCESS row (valid, complete, well-formed inputs). One fixed negative
 *     oracle applied to a success row is the run-91d6301a defect — e.g. an "empty
 *     username" case bound to a valid-credential AuthProfiles row, or validAdminInputs
 *     /validESSInputs (shouldSubmit=Yes) under a "remain on login page" assertion. The
 *     caller passes opts.caseOracleIntent (from deriveCaseOracleIntent) + the row's
 *     pre-classified opts.rowOutcome (from classifyRowOutcomeClass) so this lib stays
 *     pure (no testDataMatrix import / no circular dep).
 * We do NOT guess credential validity from values alone; only an exact match against
 * the supplied known-valid set counts (no app knowledge invented here).
 *
 * Pure + deterministic — no LLM/prisma/fs (unit-tested).
 */

const FALSEY = /^(no|false|0|n)$/i;

function pickInput(inputs, re) {
  for (const [k, v] of Object.entries(inputs || {})) { if (re.test(k)) return String(v == null ? '' : v); }
  return null;
}

/**
 * @param row   { rowClass?, label?, inputs?:{...} }
 * @param opts  { knownValidCreds?: [{ username, password }] }  — the project's
 *              authorised credential profile, used to catch a negative-intent row
 *              that nonetheless supplies the KNOWN-VALID credentials.
 */
function dataRowContractDefect(row, opts = {}) {
  if (!row || typeof row !== 'object') return null;
  const inputs = row.inputs || {};
  const cls = `${row.rowClass == null ? '' : row.rowClass} ${row.label == null ? '' : row.label}`.toLowerCase();

  // (3) NEGATIVE-intent row that uses the KNOWN-VALID credentials. You cannot test a
  //     REJECTION with valid credentials — the app will (correctly) authenticate, and
  //     the result would otherwise be misread as a product bug. This is a test-data
  //     defect. Needs the known-valid set (opts.knownValidCreds); fully generic.
  const knownValid = Array.isArray(opts.knownValidCreds) ? opts.knownValidCreds : [];
  // Negative-intent token at a SEGMENT START. Leading boundary only (no trailing \b):
  // compact classes concatenate the word ("invalidPassword", "wrongPassword",
  // "badCreds") and lowercasing erases the camelCase boundary, so "\binvalid\b" would
  // miss them. "non[-_]?existent" + the underscore-tolerant boundary cover
  // "invalid_password" / "nonexistentUser" / "non_existent_user" too.
  const negativeIntent = /(?:^|[\s_-])(invalid|wrong|incorrect|reject|fail|bad|negative|unauthor|nonexistent|non[-_]?existent|denied|nonexisting)/.test(cls)
    && !/(?:^|[\s_-])(valid[\s_-]?login|successful|success|happy[\s_-]?path|positive)/.test(cls);
  if (negativeIntent && knownValid.length) {
    const userVal = pickInput(inputs, /user|email|login/i);
    const passVal = pickInput(inputs, /pass|pwd/i);
    if (userVal != null && passVal != null && userVal !== '' && passVal !== '') {
      const matches = knownValid.some((u) => u && String(u.username) === userVal && String(u.password) === passVal);
      if (matches) {
        return `row intent is NEGATIVE ("${row.rowClass || row.label}") but the values are the KNOWN-VALID credentials (username="${userVal}") — a rejection cannot be tested with valid credentials, so the app will correctly log in. This is a test-data defect, not a product bug.`;
      }
    }
  }

  // (1) "empty <field>" class but the field has a non-empty value.
  // Match "empty password" / "emptyPassword" / "empty_username", capture the field.
  const emptyMatch = cls.match(/empty[\s_-]*([a-z][a-z0-9]+)/);
  if (emptyMatch) {
    const fieldWord = emptyMatch[1]; // e.g. 'password', 'username'
    for (const [k, v] of Object.entries(inputs)) {
      const val = String(v == null ? '' : v).trim();
      if (k.toLowerCase().includes(fieldWord) && val !== '') {
        return `row class "${row.rowClass || row.label}" indicates an EMPTY ${fieldWord}, but the row supplies ${k}="${val}". The data contradicts its own declared intent.`;
      }
    }
  }

  // (2) shouldSubmit / submit explicitly false, yet the row supplies the full set of
  //     values a submit needs (username + password both non-empty) → contradictory.
  const submitKey = Object.keys(inputs).find((k) => /^(shouldsubmit|submit|dosubmit)$/i.test(k));
  if (submitKey && FALSEY.test(String(inputs[submitKey] || '').trim())) {
    const nonEmpty = Object.entries(inputs).filter(([k, v]) => k !== submitKey && String(v == null ? '' : v).trim() !== '');
    const hasUser = nonEmpty.some(([k]) => /user|email|login/i.test(k));
    const hasPass = nonEmpty.some(([k]) => /pass|pwd/i.test(k));
    if (hasUser && hasPass) {
      return `row sets ${submitKey}="${inputs[submitKey]}" (do not submit), but supplies complete credentials — the row's values contradict its "no submit" intent.`;
    }
  }

  // (4) CASE-vs-ROW intent mismatch. The CASE's oracle expects a NEGATIVE outcome
  //     (stay on login / required-field error / rejection) but THIS row is a clear
  //     SUCCESS row → the fixed negative oracle cannot judge this row, so it would
  //     mis-score the SITE. Block as a test-data/binding defect, NOT a product bug.
  //     Conservative: only when the case is confidently negative AND the row is a
  //     success row at high/medium confidence (low-confidence stays unflagged).
  if (opts.caseOracleIntent === 'negative' && opts.rowOutcome
      && opts.rowOutcome.class === 'success'
      && (opts.rowOutcome.confidence === 'high' || opts.rowOutcome.confidence === 'medium')) {
    return `case oracle expects a NEGATIVE outcome (remain on login / validation error / rejection) but this row is a SUCCESS row (valid, complete inputs${row.label ? ` — "${row.label}"` : ''}). A fixed negative assertion cannot judge a success row — bind success rows to a success-asserting case or use the row's own {{expected}} per-row. This is a case/data binding defect, not a website failure.`;
  }
  return null;
}

/**
 * Derive a CASE's oracle intent — 'negative' (expects to stay on login / show a
 * required-field or rejection error / be denied), 'positive' (expects to reach an
 * authenticated destination), or null (ambiguous → never flag). Deterministic +
 * conservative: returns 'negative' only on a STRONG signal so the (4) mismatch
 * check above under-flags rather than false-blocking a legitimate success row.
 * Generic — keyed off the case's own name + declared-assertion content + the
 * architect's credentialHint, never any site string.
 *
 * @param testCase { name?, declaredAssertions?: array|JSON-string, credentialHint? }
 */
function deriveCaseOracleIntent(testCase) {
  if (!testCase || typeof testCase !== 'object') return null;
  if (testCase.credentialHint === 'invalid') return 'negative';
  const name = String(testCase.name || '').toLowerCase();
  const intentName = name
    .replace(/\b(?:non|not)[\s_-]*empty\b/g, '')
    .replace(/\bnonempty\b/g, '');
  let decl = [];
  try {
    decl = Array.isArray(testCase.declaredAssertions) ? testCase.declaredAssertions
      : (typeof testCase.declaredAssertions === 'string' ? JSON.parse(testCase.declaredAssertions || '[]') : []);
  } catch (_) { decl = []; }
  const declText = JSON.stringify(Array.isArray(decl) ? decl : []).toLowerCase();

  // Strong negative signals in the declared-assertion content.
  const NEG = /(remains?|stays?|still)[\s_-]*on[\s_-]*(the[\s_-]*)?(login|sign[\s_-]?in|auth)|login[\s_-]*(page|form)[\s_-]*(visible|present|remains?|shown)|required[\s_-]*(field|validation)|inline[\s_-]*(error|validation|message)|invalid[\s_-]*credential|incorrect[\s_-]*(password|credential|user|login)|reject(ed|ion)?|denied|unauthor|must[\s_-]*not[\s_-]*(login|authenticate|proceed|succeed)/;
  // Strong positive signals.
  const POS = /redirect(ed)?[\s_-]*to[\s_-]*(the[\s_-]*)?(dashboard|home|landing)|lands?[\s_-]*on[\s_-]*(the[\s_-]*)?(dashboard|home)|successful(ly)?[\s_-]*(log|authenticat|sign)|authenticated[\s_-]*home|reaches?[\s_-]*the[\s_-]*dashboard/;
  // Case-NAME negative shape (e.g. "empty username", "invalid login", "rejected").
  const nameNeg = /(empty|blank|missing|invalid|wrong|incorrect|reject|required|negative|unauthor|denied|nonexist|non[-_]?existent|lock(ed|out))/.test(intentName);

  const declNeg = NEG.test(declText);
  const declPos = POS.test(declText);
  if ((declNeg || nameNeg) && !declPos) return 'negative';
  if (declPos && !declNeg && !nameNeg) return 'positive';
  return null;
}

module.exports = { dataRowContractDefect, deriveCaseOracleIntent };
