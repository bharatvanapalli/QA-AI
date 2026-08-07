'use strict';

/**
 * Page-context helpers for the conductor page-drift guard (B-2e).
 *
 * Derives the intended app MODULE for a step from whatever URL signal it carries
 * — NOT only an Architect-emitted urlPattern (many cases, e.g. a306ab75, declare
 * none). Signals, in priority: urlPattern / expectedUrl, verify.url, a navigate
 * step's value/url. Combined with a tracked "workflow module", this lets the
 * conductor freeze when an action would run on a different module than intended.
 * Generic — module = the path segment after /index.php/ (works across SPAs).
 */

function moduleOfUrl(u) {
  const m = /\/index\.php\/([a-z0-9_-]+)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase() : null;
}

function expectedModuleForStep(step) {
  if (!step || typeof step !== 'object') return null;
  const isNav = /navigate|goto|open/i.test(String(step.action || ''));
  const candidates = [
    step.urlPattern,
    step.expectedUrl,
    step.verify && step.verify.url,
    isNav ? (step.value || step.url) : null,
  ];
  for (const c of candidates) { const m = moduleOfUrl(c); if (m) return m; }
  return null;
}

// A login/auth page — landing here usually means "not authenticated" or "session
// expired". Re-authenticating here is UNIVERSAL recovery, never page drift.
function isAuthPage(url) { return /\/(login|auth|signin|sign-in|sso|logon)\b/i.test(String(url || '')); }

function pageDriftDecision({ workflowModule = null, currentUrl = null, step = null, toolName = null } = {}) {
  const currentModule = moduleOfUrl(currentUrl);
  const expectedModule = expectedModuleForStep(step);
  const tool = String(toolName || '');
  if (!currentModule) {
    return { block: false, currentModule, expectedModule, workflowModule, nextWorkflowModule: workflowModule, note: null, reason: null };
  }
  // Session-expiry / re-auth recovery: never block actions on a login/auth page.
  // The app bounced us here (or we started here); re-login is the correct move,
  // not "drift". Reset the tracked module so the flow re-establishes cleanly.
  if (isAuthPage(currentUrl)) {
    return { block: false, currentModule, expectedModule, workflowModule, nextWorkflowModule: currentModule, note: 'auth/login page — re-authentication allowed (session recovery)', reason: null };
  }
  let nextWorkflowModule = workflowModule || currentModule;
  if (workflowModule && currentModule !== workflowModule && tool !== 'browser_navigate') {
    if (expectedModule && expectedModule === currentModule) {
      nextWorkflowModule = currentModule;
      return { block: false, currentModule, expectedModule, workflowModule, nextWorkflowModule, note: null, reason: null };
    }
    return {
      block: true,
      currentModule,
      expectedModule,
      workflowModule,
      nextWorkflowModule,
      note: null,
      reason: `page drift — workflow is "${workflowModule}" but browser is on "${currentModule}" (${currentUrl}). Navigate back before acting.`,
    };
  }
  const note = expectedModule && expectedModule !== currentModule && tool !== 'browser_navigate'
    ? `step expects module "${expectedModule}" but browser is on "${currentModule}"`
    : null;
  return { block: false, currentModule, expectedModule, workflowModule, nextWorkflowModule, note, reason: null };
}

module.exports = { moduleOfUrl, expectedModuleForStep, pageDriftDecision, isAuthPage };
