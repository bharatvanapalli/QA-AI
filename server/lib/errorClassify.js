'use strict';

/**
 * P0-11 — canonical error classifier + locator extractor.
 *
 * Previously duplicated in server/services/runs.js (5 categories) and
 * the retired legacy Conductor (12+ categories). A locator failure
 * recorded by one path landed in different BlockedItem categories than the
 * other, fragmenting Reports filters. Conductor's version is canonical
 * (more specific patterns, agent-side signals like agent_loop /
 * agent_repeating); both call sites now import it from here.
 *
 * Generic rule: drift-prone constants live in one file.
 */

/**
 * Classify a blocker message into a stable kind. The kind drives both the
 * UI (which input fields to show, which "action" hint to surface) and the
 * dashboard counters. Order matters — more specific patterns first.
 */
function classifyError(msg) {
  const s = String(msg || '').toLowerCase();

  // Agent loop / hint cap / retry exhaustion. Written by the conductor's
  // own loop-detection code; nothing to do with locators — the user cannot
  // fix them by supplying a selector.
  if (s.includes('assertion_contract_defect') || s.includes('assertion contract defect')) return 'assertion_contract_defect';
  if (s.includes('hint_cap') || s.includes('hint(s) without progress')) return 'agent_loop';
  if (s.includes('consecutive_errors') || s.includes('same error 3x') || s.includes('same error in a row')) return 'agent_repeating';
  if (s.includes('30-turn ceiling') || s.includes('turn ceiling') || s.includes('max turns reached')) return 'agent_loop';
  if (s.includes('identical tool calls') || s.includes('identical_tool')) return 'agent_loop';

  // Browser / page lifecycle. Surfaced when chromium isn't installed, the
  // page crashes, or the agent tries to talk to a closed page.
  if (s.includes('browser is not installed') || s.includes('chromium is not installed')) return 'browser_missing';
  if (s.includes('target closed') || s.includes('browser has been closed') ||
      s.includes('page closed') || s.includes('page crashed') ||
      s.includes('execution context was destroyed') || s.includes('context closed')) return 'browser_crash';

  // External challenges the user is expected to know about.
  if (s.includes('captcha') || s.includes('recaptcha') || s.includes('hcaptcha') || s.includes('cloudflare challenge')) return 'captcha';
  if (s.includes('consent banner') || s.includes('cookie banner') || s.includes('cookie consent') ||
      s.includes('modal') || s.includes('popup') || s.includes('dialog blocked')) return 'popup';

  // Auth / permission.
  if (s.includes('401') || s.includes('unauthorized') || s.includes('unauthenticated')) return 'auth';
  if (s.includes('403') || s.includes('forbidden')) return 'permission';

  // Network / connectivity.
  if (s.includes('network') || s.includes('econnrefused') || s.includes('enotfound') ||
      s.includes('dns') || s.includes('net::err')) return 'network';

  // Locator-shaped. Includes Playwright's "Unknown engine ref" and the
  // generic "not found / locator / selector" phrasings.
  if (s.includes('unknown engine "ref"') || (s.includes('ref=') && s.includes('not found'))) return 'locator_missing';
  if (s.includes('locator') || s.includes('selector') || s.includes('no element matches')) return 'locator_missing';

  // Timing.
  if (s.includes('timeout') || s.includes('timed out')) return 'timeout';

  // Assertion.
  if (s.includes('expect(') || s.includes('expected ') || s.includes('assertion')) return 'assertion';

  return 'unknown';
}

function extractLocator(msg) {
  if (!msg) return null;
  const m = String(msg).match(/ref=([\w-]+)|locator\(['"]([^'"]+)['"]\)|getBy(?:Role|TestId|Label|Text)\(['"]([^'"]+)['"]\)/i);
  return m ? (m[1] || m[2] || m[3]) : null;
}

module.exports = { classifyError, extractLocator };
