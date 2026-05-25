'use strict';

/**
 * Compose an agent's system prompt with user-provided guidance prepended.
 *
 * Every agent (Architect / Planner / Conductor / Critic / Supervisor /
 * Analyst / Reporter) accepts an `extraGuidance` parameter which contains
 * either:
 *   - the project's `aiGuidance` field (set by the user in Settings → Claude
 *     to guide AI behaviour across the whole project), and/or
 *   - the test case's `userGuidance` field (set by the user on a specific
 *     failed test in the Reports detail pane — e.g. "always wait for the
 *     spinner before clicking submit").
 *
 * The composer wraps the guidance in a clearly-fenced block so Claude knows
 * the difference between operator-supplied guidance (which takes precedence
 * for ambiguous cases) and the base system prompt (which carries the
 * agent's domain rules).
 *
 * If guidance is empty / whitespace-only / null, returns the base prompt
 * unchanged so the wire-up is no-op for projects that haven't set anything.
 */

const HEADER = '## OPERATOR GUIDANCE (apply these when they conflict with general rules below)';
const FOOTER = '\n\n---\n\n';

/**
 * @param {string} basePrompt   The agent's existing SYSTEM_PROMPT.
 * @param {string|null} guidance Free-form text from the user. Multiple
 *                               guidance sources can be joined with `\n\n`
 *                               before passing in — the composer doesn't
 *                               parse them.
 */
function composeSystemPrompt(basePrompt, guidance) {
  if (!guidance || typeof guidance !== 'string') return basePrompt;
  const trimmed = guidance.trim();
  if (!trimmed) return basePrompt;
  return `${HEADER}\n${trimmed}${FOOTER}${basePrompt}`;
}

/**
 * Convenience: join project-level + sprint-level + case-level guidance into
 * one block, labelled so Claude sees the source. Any field can be null/empty.
 *
 * Order = broad → narrow (project → sprint → case). When two layers conflict
 * the narrower one wins by virtue of appearing last; the model is also told
 * (via the agent's base prompt) to honour operator guidance first.
 */
function joinGuidance({ projectGuidance, sprintGuidance, caseGuidance } = {}) {
  const parts = [];
  if (projectGuidance && projectGuidance.trim()) {
    parts.push(`### Project-wide guidance\n${projectGuidance.trim()}`);
  }
  if (sprintGuidance && sprintGuidance.trim()) {
    parts.push(`### Active sprint\n${sprintGuidance.trim()}`);
  }
  if (caseGuidance && caseGuidance.trim()) {
    parts.push(`### This test case\n${caseGuidance.trim()}`);
  }
  return parts.length ? parts.join('\n\n') : null;
}

module.exports = { composeSystemPrompt, joinGuidance };
