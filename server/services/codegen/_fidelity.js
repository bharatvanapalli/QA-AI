'use strict';

/**
 * Verdict fidelity — make the EXPORTED spec reproduce the MCP run's verdict.
 *
 * THE REQUIREMENT
 * "Whatever framework I select, the generated spec files should behave as MCP
 *  ran: if it failed in real time it should fail; if all cases passed in Reports
 *  my exported code should not fail even a single test."
 *
 * WHY IT DRIFTED
 * Codegen was handed testCase.assertions — a FREEFORM human sentence
 * ("Emergency Contacts tab shows 'Assigned Emergency Contacts' header. [Covers:
 *  REQ-007]"). From a sentence the model invents what to assert, with what
 * expected value, at what criticality. Meanwhile the run's verdict was computed
 * from testCase.declaredAssertions — a STRUCTURED contract (type, criticality
 * must|should|incidental, payload.expectedText/expectedUrl/…, targetUrl,
 * checkAt). The spec asserted different things than the verdict → drift in both
 * directions (false reds on passing cases, false greens on failing ones).
 *
 * THE FIX
 * Hand model-driven codegen the SAME structured declaredAssertions. ReplayIR
 * exports only hard-assert declared checks that had a recorded liveOutcome;
 * missing live outcomes are reported as coverage gaps instead of pretending the
 * website failed. Combined with the verdict (caseStatus), this preserves parity
 * without inventing assertions the agent never verified.
 */

function projectDeclaredAssertions(arr) {
  // Project to just what codegen needs (id/type/criticality/payload/target/checkAt).
  return arr
    .filter((a) => a && a.type)
    .map((a) => ({
      id: a.id || null,
      type: a.type,
      criticality: a.criticality || 'must',
      payload: a.payload || {},
      targetUrl: a.targetUrl || null,
      checkAt: a.checkAt || 'end',
      note: a.note || null,
    }));
}

// Pull the structured declared assertions off a test case while preserving the
// difference between missing metadata and an intentionally empty assertion list.
function declaredAssertionsStateFor(testCase) {
  const hasField = !!testCase && Object.prototype.hasOwnProperty.call(testCase, 'declaredAssertions');
  const raw = hasField ? testCase.declaredAssertions : null;
  if (raw == null) return { state: 'missing', declared: [], rawCount: null, declaredCount: 0, error: null };
  let arr = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return { state: 'invalid', declared: [], rawCount: null, declaredCount: 0, error: 'empty string' };
    try { arr = JSON.parse(raw); } catch (err) {
      return { state: 'invalid', declared: [], rawCount: null, declaredCount: 0, error: err && err.message ? String(err.message) : 'invalid JSON' };
    }
  }
  if (!Array.isArray(arr)) return { state: 'invalid', declared: [], rawCount: null, declaredCount: 0, error: 'not an array' };
  const declared = projectDeclaredAssertions(arr);
  return {
    state: arr.length === 0 ? 'empty' : 'present',
    declared,
    rawCount: arr.length,
    declaredCount: declared.length,
    error: null,
  };
}

// Back-compatible array-only helper for existing model-driven emitters.
function declaredAssertionsFor(testCase) {
  return declaredAssertionsStateFor(testCase).declared;
}

// A compact, model-readable digest of the declared assertions for the user
// message (so the model sees expected values + criticality explicitly, not
// buried in JSON it might skim).
function assertionDigest(declared) {
  if (!declared.length) return null;
  return declared.map((a, i) => {
    const p = a.payload || {};
    const expected = p.expectedText ?? p.expectedUrl ?? p.expectedRole ?? p.unexpectedText ?? p.unexpectedRole
      ?? (p.expectedSignals ? JSON.stringify(p.expectedSignals) : '') ?? '';
    return `${i + 1}. [${a.criticality.toUpperCase()}] ${a.type}` +
      (expected ? ` expected=${JSON.stringify(expected)}` : '') +
      (a.targetUrl ? ` @ ${a.targetUrl}` : '') +
      ` (checkAt:${a.checkAt})`;
  }).join('\n');
}

// The fidelity directive injected into the system prompt. lang switches the
// concrete assertion examples between Playwright (ts/js) and Selenium (java).
function fidelityBlock({ lang = 'ts' } = {}) {
  const pwExamples =
`    TEXT            → presence ANYWHERE the user perceives the text — body text, a field PLACEHOLDER, a label, or an accessible name. The run's verdict matched this text against the page's ACCESSIBILITY SNAPSHOT, where a form field's placeholder/label (e.g. an input whose placeholder is "First Name") counts as the text being present. A bare page.getByText() only matches rendered TEXT NODES, so it MISSES placeholder/label text and FALSELY FAILS a case that actually passed (extremely common on forms). Use a tolerant .or() chain so the matcher reproduces the snapshot semantics:
                        await expect(
                          page.getByText(expected, { exact: false })
                            .or(page.getByPlaceholder(expected, { exact: false }))
                            .or(page.getByRole('textbox', { name: expected }))
                            .or(page.getByLabel(expected, { exact: false }))
                            .first()
                        ).toBeVisible({ timeout });
                      (This is NOT "upgrading" the check — it is the SAME presence check, tolerant of WHERE the text lives, exactly as the run matched it. Do not narrow it back to getByText alone.)
    URL             → await expect(page).toHaveURL(/<segment>/) with a slash-FREE distinctive segment (e.g. /viewEmployeeList/), OR expect(page.url()).toContain('<path>'). NEVER write a regex that starts with two slashes (e.g. //pim/viewEmployeeList/) — "//" begins a line comment and breaks the whole file. If the path needs slashes, use toContain with a string instead of a regex.
    ROLE            → await expect(page.getByRole(role, { name }).first()).toBeVisible()
- STRICT MODE: a bare getByText/getByRole that matches MORE THAN ONE element (e.g. a tab link AND a heading both reading "Personal Details") throws a strict-mode violation and FAILS a case that actually passed. For a presence/visibility assertion ALWAYS append .first() (or narrow with an exact role/name) so "the text/element is present" does not break on a duplicate match.
    PAGE            → assert the page's primary indicator from expectedSignals using the signal's structural type — NOT the TEXT .or()-chain:
                        heading signal → await expect(page.getByRole('heading', { name: /expectedText/i }).first()).toBeVisible({ timeout })
                        url signal     → await expect(page).toHaveURL(/urlSegment/)
                        role signal    → await expect(page.getByRole(role, { name: /name/i }).first()).toBeVisible({ timeout })
                      A PAGE assertion is structural identity evidence; the TEXT .or()-chain is ONLY for TEXT assertions.
    FORBIDDEN_TEXT  → await expect(page.getByText(value)).toHaveCount(0)
    FORBIDDEN_ROLE  → await expect(page.getByRole(role, { name })).toHaveCount(0)`;
  const javaExamples =
`    TEXT            → assertTrue(driver.getPageSource().contains(expected), "expected text: " + expected)  (or locate the element + assert its text)
    URL             → assertTrue(driver.getCurrentUrl().contains(expected), "expected url: " + expected)
    ROLE            → assert the element located by its accessible name/role is displayed
    FORBIDDEN_TEXT  → assertFalse(driver.getPageSource().contains(value), "should not contain: " + value)`;
  const examples = lang === 'java' ? javaExamples : pwExamples;
  const soft = lang === 'java'
    ? 'a SoftAssert entry (softAssert.assertAll() at the end)'
    : 'expect.soft(...)';
  const hard = lang === 'java' ? 'a hard TestNG assert (assertTrue/assertEquals with a message)' : 'a hard expect(...)';

  return `## VERDICT FIDELITY — the exported spec MUST reproduce this run's verdict
You are given "caseStatus" (pass | fail | blocked — the verdict the MCP run reached) and "declaredAssertions" (the EXACT structured checks that verdict was computed from). Your spec MUST assert those same checks so it reaches the same verdict standalone.

- ASSERT EXACTLY THE DECLARED SET — NO MORE, NO LESS. If there are N declared assertions, emit N assertions and NOT ONE extra. The MCP run's verdict was computed ONLY from these declared assertions; it NEVER checked anything else. Do NOT invent additional checks to "be thorough" — no extra fields, filter inputs, buttons, columns, tabs, counts, or pages that are not a declared assertion. Every invented check is an UNGROUNDED guess against a DOM you cannot see, and at scale it manufactures false failures on cases that actually passed. Reaching the right page and asserting only the declared values is the whole job.
- Use the matcher for the declared TYPE — do not "upgrade" it. A TEXT assertion is satisfied by the text being present (getByText) — do NOT turn it into a getByRole('textbox'/'combobox'/…) locator you are guessing; that is a different, stricter, ungrounded check that will fail even when the text is present.

- Emit ONE assertion per declared assertion, using its declared expected value VERBATIM and the matcher for its type:
${examples}
- Criticality decides hard vs soft: "must"/"should" → ${hard}; "incidental" → ${soft} (an incidental check must never, on its own, flip the verdict).
- NEVER substitute the declared expected value with whatever the app actually showed. NEVER weaken a must/should to a trivially-true check. NEVER omit a declared assertion. NEVER wrap an assertion in try/catch or .catch(() => {}) that swallows its failure.
- If caseStatus is "pass": every must/should assertion held during the run — your spec MUST go GREEN. (The shared login + correct locators get you to the assertion; then the declared expectations hold.)
- If caseStatus is "fail" or "blocked": at least one declared expectation was NOT met in the run. Assert the declared values faithfully anyway — your spec SHOULD go RED, reproducing the real failure. A GREEN spec for a non-pass case is WRONG; do not "repair" the test to make it pass.`;
}

module.exports = { declaredAssertionsFor, declaredAssertionsStateFor, assertionDigest, fidelityBlock };
