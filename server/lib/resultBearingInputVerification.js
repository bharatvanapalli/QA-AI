'use strict';

/**
 * Universal RESULT-BEARING INPUT PROTOCOL (B-2e).
 *
 * Generalises the autocomplete no-results handling into ONE engine for controls
 * that are responsible for producing a result surface: autocomplete / typeahead,
 * lookup pickers, dropdown searches, explicit Search actions, table / list / grid
 * searches, and entity/result pickers.
 *
 * Important boundary: a plain Fill into a search/filter textbox is NOT itself a
 * result-bearing step when the approved flow has a later Click Search / Verify
 * Results step. In that common pattern, the fill only supplies criteria; the
 * result oracle belongs to the Search/Verify step. Treating the fill as
 * result-bearing blocks too early and makes reports say the website failed
 * before the search even ran.
 *
 * It (1) detects an EMPTY-result state by generic vocabulary (no site classes),
 * (2) classifies the step's INTENT (a matching record is required vs an empty
 * result is the expected/negative outcome vs unknown), and (3) decides the
 * outcome:
 *   - expect_match + empty  → terminal test_data_invalid / precondition_failed
 *   - expect_empty + empty  → pass (the negative assertion is satisfied)
 *   - unknown   + empty     → needs_intent (block; never improvise data)
 *
 * Pure + deterministic — unit-tested. The conductor inspects the result surface
 * (snapshot text) and calls decideResultOutcome.
 */

// Generic empty-result vocabulary — covers autocomplete panels, search/grid empty
// states, filter "no data", picker "no options". NO site-specific strings.
const EMPTY_RESULT_RE = /\b(no records?(?: found)?|no results?(?: found)?|no matches?(?: found)?|no matching(?: records?| rows?)?|no data(?: available| found)?|no items?(?: found)?|nothing found|no options?|no employees?(?: found)?|no users?(?: found)?|0 results?|0 records?|zero results?)\b/i;

/** True when the result surface shows an empty / no-match state. */
function hasEmptyResult(snapshotText) {
  return EMPTY_RESULT_RE.test(String(snapshotText == null ? '' : snapshotText));
}

function emptyResultText(snapshotText) {
  const m = EMPTY_RESULT_RE.exec(String(snapshotText == null ? '' : snapshotText));
  return m ? m[0] : null;
}

function expectsPositiveResultSurface(step = {}) {
  const t = `${step.action || ''} ${step.expected || ''} ${step.element || ''} ${step.target || ''} ${step.intent || ''}`.toLowerCase();
  if (!t.trim()) return false;
  if (classifyResultIntent(step) === 'expect_empty') return false;
  const hasPositiveOutcome = /\b(found|finds?|returned|returns|appears?|visible|shown|displayed|present|exists?|listed|in\s+(?:the\s+)?list|in\s+(?:the\s+)?results?)\b/.test(t);
  const hasResultSurface = /\b(record|row|result|results|list|table|grid|item|entry|card|tile|option|suggestion|match|matches)\b/.test(t);
  return hasPositiveOutcome && hasResultSurface;
}

/** Is this approved step a result-bearing input action (search / autocomplete / lookup / filter)? */
function isResultBearingStep(step) {
  const action = String((step && step.action) || '').trim().toLowerCase();
  const element = String((step && step.element) || '').trim().toLowerCase();
  const expected = String((step && step.expected) || '').trim().toLowerCase();
  const intent = String((step && step.intent) || '').trim().toLowerCase();
  const t = `${action} ${expected} ${element} ${intent}`.toLowerCase();
  if (!t.trim()) return false;
  const isFillLike = /^(?:fill|type|enter|input)$/.test(action);
  const explicitSearchAction = /^(?:search|filter|find|lookup|look up)$/.test(action)
    || /\b(?:search|filter|find|lookup|look up)\b/.test(action);
  if (explicitSearchAction) return true;
  const pickerFill = /\b(autocomplete|typeahead|type[- ]?ahead|suggestion|lookup|look up|picker|type for hints|dropdown search)\b/.test(t);
  if (isFillLike) return pickerFill;
  return pickerFill
    || /\bresults? (?:table|list|grid)\b/.test(t)
    || /\b(?:select|choose|pick)\b[^.]{0,40}?\b(?:record|option|item|result|row|suggestion|match|entry|card|tile)\b/.test(t);
}

/**
 * Classify what the step EXPECTS from the result surface.
 * @returns {'expect_match'|'expect_empty'|'unknown'}
 */
function classifyResultIntent(step) {
  const t = `${(step && step.action) || ''} ${(step && step.expected) || ''} ${(step && step.element) || ''} ${(step && step.intent) || ''}`.toLowerCase();
  if (!t.trim()) return 'unknown';
  // Negative / empty-state expectation (the test WANTS no results).
  if (/\b(no results?|no records?|empty(?: state)?|not found|zero results?|no matching|should (?:not|never) (?:exist|appear|be found|return)|expect(?:s|ed)? (?:no|zero|empty))\b/.test(t)) return 'expect_empty';
  // A matching record must exist / be selected. Two generic signals:
  //   (a) result-surface vocabulary (suggestion/autocomplete/lookup/results table/…);
  //   (b) a select/choose/pick verb that references a result NOUN, allowing natural
  //       phrasing with determiners/adjectives in between ("select the Manager option",
  //       "select the matching row", "pick the first suggestion"). The old regex
  //       only matched "select a/an <noun>", so "select the … option" wrongly fell
  //       through to unknown — generic phrasing, not a site fix.
  if (/\b(suggestion|autocomplete|typeahead|lookup|must (?:exist|appear|be found|return)|results? (?:table|list|grid)|matching (?:record|row|result)|shows? (?:suggestions?|results?|matches?))\b/.test(t)) return 'expect_match';
  if (/\b(?:select|choose|pick)\b[^.]{0,40}?\b(?:record|option|item|result|row|suggestion|match|entry|card|tile)\b/.test(t)) return 'expect_match';
  return 'unknown';
}

/**
 * Decide the outcome of a result-bearing action from the result surface + intent.
 * @returns {{ empty:boolean, intent?:string, outcome:string }}
 *   outcome ∈ has_results | pass_expected_empty | terminal_test_data_invalid | needs_intent
 */
function decideResultOutcome({ step = null, snapshotText = '' } = {}) {
  // Capture the ACTUAL empty-result phrase the site showed (e.g. "No results found",
  // "No matching records", "No options") so the user-facing explanation quotes what
  // the app really returned — not a hardcoded "No Records Found". Generic per-site.
  const emptyText = emptyResultText(snapshotText);
  if (!emptyText) return { empty: false, outcome: 'has_results' };
  const intent = classifyResultIntent(step);
  if (intent === 'expect_empty') return { empty: true, intent, emptyText, outcome: 'pass_expected_empty' };
  if (intent === 'expect_match') return { empty: true, intent, emptyText, outcome: 'terminal_test_data_invalid' };
  return { empty: true, intent: 'unknown', emptyText, outcome: 'needs_intent' };
}

module.exports = { hasEmptyResult, emptyResultText, expectsPositiveResultSurface, isResultBearingStep, classifyResultIntent, decideResultOutcome, EMPTY_RESULT_RE };
