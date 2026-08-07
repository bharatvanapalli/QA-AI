'use strict';

const CONTROL_ROLE_PREFIX_RE = /^(?:the\s+)?(?:button|link|option)\s+(?!to\b)/i;
const CONTROL_ROLE_SUFFIX_RE = /\s+(?:button|link|option)$/i;
const STRUCTURAL_CONTEXT_SUFFIX_RE = /(\s+(?:button|link|option))\s+(?:on|in)\s+(?:(?:the|a|an)\s+)?[^,.;]+?\s+(?:page|screen|dialog|modal|form|panel|section)$/i;

/**
 * Reduce an authored control description to the accessible-name portion that
 * Playwright should match. Structural role words and page/dialog context are
 * generic metadata; provider and product names must never be hard-coded here.
 */
function normalizeInteractiveControlName(value) {
  const authored = String(value || '').trim();
  if (!authored) return '';

  const withoutContext = authored.replace(STRUCTURAL_CONTEXT_SUFFIX_RE, '$1').trim();
  return withoutContext
    .replace(CONTROL_ROLE_PREFIX_RE, '')
    .replace(CONTROL_ROLE_SUFFIX_RE, '')
    .trim() || authored;
}

module.exports = {
  normalizeInteractiveControlName,
};
