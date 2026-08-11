'use strict';

/**
 * requirementDocNormalizer.js — Ingestion Normalizer for User Stories & Requirement Docs
 *
 * Sits between docs.js#extractText and caseContractV1.js/Architect.
 * Rewrites arbitrary markdown headings, BDD phrasing, and free-form acceptance criteria
 * into the canonical colon-suffixed headers (SECTION_NAMES / ASSERTION_SECTIONS)
 * that caseContractV1.js deterministically parses without modification.
 */

const { getProvider } = require('../lib/llmProvider');
const { resolveAiCredentials } = require('../lib/resolveAiCredentials');

const CANONICAL_SECTION_PATTERNS = [
  /^\s*Requirement\s+Title\s*:/im,
  /^\s*Scenario\s*:/im,
  /^\s*Steps\s*:/im,
  /^\s*Test\s+Data\s*:/im,
  /^\s*Final\s+Validation\s*:/im,
  /^\s*Expected\s+Result\s*:/im,
  /^\s*Session\s+Policy\s*:/im,
];

const MODAL_HELPERS_RE = /\b(?:should\s+be|must\s+be|needs?\s+to\s+be|is\s+expected\s+to\s+be|ought\s+to\s+be)\b/gi;

/**
 * Strips English modal helper verbs from assertion phrases to make assertions direct and declarative.
 * e.g. "The button should be disabled" -> "The button is disabled"
 */
function stripModalHelpers(text) {
  return String(text || '').replace(MODAL_HELPERS_RE, 'is');
}

/**
 * Fast check: Does this document already use canonical colon-suffixed headers throughout?
 */
function isAlreadyCanonical(text) {
  const body = String(text || '');
  const hasCanonicalSteps = /^\s*Steps\s*:/im.test(body);
  const hasMarkdownAtxSteps = /^\s*#{1,6}\s*Steps\b/im.test(body);
  const hasUnrecognizedSectionAmpersand = /^\s*#{0,6}\s*[^:\n]*&[^:\n]*$/m.test(body);
  const hasMustTags = /\[(?:Must|Should|Critical)\]/i.test(body);

  return hasCanonicalSteps && !hasMarkdownAtxSteps && !hasUnrecognizedSectionAmpersand && !hasMustTags;
}

/**
 * Deterministic pre-pass to normalize simple ATX headers, strip modal helpers, clean [Must]/[Should] tags,
 * and clean noisy conversational phrases into concise action targets.
 */
function deterministicNormalize(text) {
  let cleaned = stripModalHelpers(text);

  // Strip [Must], [Should], [Optional] tags from validation lines
  cleaned = cleaned.replace(/\s*\[(?:Must|Should|Critical|Optional|Incidental)\]\s*/gi, ' ');

  // Normalize standard Markdown ATX headers to colon-suffixed headers
  cleaned = cleaned.replace(/^\s*#{1,6}\s*(?:User\s+Story|Feature|Requirement\s+Title|Title)\s*:\s*(.+)$/gim, 'Requirement Title: $1');
  cleaned = cleaned.replace(/^\s*#{1,6}\s*(?:User\s+Story|Feature|Requirement)\s*[-—–]\s*(.+)$/gim, 'Requirement Title: $1');
  cleaned = cleaned.replace(/^\s*#{1,6}\s*Scenario\s*(?:\d+)?\s*:\s*(.+)$/gim, 'Scenario: $1');
  cleaned = cleaned.replace(/^\s*#{1,6}\s*(?:Steps|Test\s+Steps|Test\s+Procedure|Procedure|Flow)\s*$/gim, 'Steps:');
  cleaned = cleaned.replace(/^\s*#{1,6}\s*(?:Validations?\s*(?:&|and)\s*Acceptance\s*Criteria|Acceptance\s*Criteria|Validations?|Expected\s*Results?|Final\s*Validation)\s*$/gim, 'Final Validation:');
  cleaned = cleaned.replace(/^\s*#{1,6}\s*(?:Test\s*Data|Inline\s*Test\s*Data|Data)\s*$/gim, 'Test Data:');
  cleaned = cleaned.replace(/^\s*#{1,6}\s*(?:Session\s*(?:&|and)\s*Dependency|Session\s*Policy|Session\s*Requirement)\s*$/gim, 'Session Policy:');

  // Ensure standalone "Verify that 'quoted text'" without predicate becomes "Verify that 'quoted text' is visible"
  cleaned = cleaned.replace(/\bVerify\s+(?:that\s+)?("(?:[^"\\]|\\.)+"|'[^']+')(?:\s*)$/gim, 'Verify that $1 is visible');

function splitOutsideQuotes(text) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if ((char === '"' || char === "'" || char === '“' || char === '”') && (i === 0 || text[i - 1] !== '\\')) {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar || (quoteChar === '“' && char === '”')) {
        inQuotes = false;
        quoteChar = '';
      }
      current += char;
    } else if (!inQuotes && text.slice(i).match(/^\s+(?:-|—)\s+/)) {
      const match = text.slice(i).match(/^\s+(?:-|—)\s+/)[0];
      if (current.trim()) parts.push(current.trim());
      current = '';
      i += match.length - 1;
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length ? parts : [text.trim()];
}

  // Expand single-line numbered steps with inline ' - ' or ' — ' into sequential numbered steps
  const expandedLines = [];
  let stepNumber = 1;
  for (const line of cleaned.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (match) {
      const parts = splitOutsideQuotes(match[1]);
      for (const part of parts) {
        let item = part.trim();
        if (item) {
          item = item.replace(/\bVerify\s+(?:that\s+)?("(?:[^"\\]|\\.)+"|'[^']+')\s*$/i, 'Verify that $1 is visible');
          expandedLines.push(`${stepNumber}. ${item}`);
          stepNumber += 1;
        }
      }
    } else {
      expandedLines.push(line);
    }
  }
  cleaned = expandedLines.join('\n');

  if (!/^\s*(?:Scenario|Steps|Requirement\s+Title)\s*:/im.test(cleaned)) {
    cleaned = `Scenario: User Flow\n\nSteps:\n${cleaned}`;
  }

  return cleaned.trim();
}

const SYSTEM_PROMPT = `You are a strict QA requirement structure normalizer.
Your ONLY job is to take an uploaded requirement document (user story, BDD scenario, or natural conversational test notes)
and rewrite it into the EXACT canonical colon-suffixed section format required by the deterministic test compiler.

CANONICAL SECTIONS TO USE (MUST USE COLON SUFFIX):
- Requirement Title: <Feature or story title>
- Module: <module name>
- Priority: P0 | P1 | P2 | P3
- Session Policy: <Fresh Session | Continuation>
- Test Data:
  (Preserve markdown tables and {{tokens}} verbatim)
- Scenario: <Scenario Name>
  Type: Functional | Smoke | Regression | Negative | Boundary
- Steps:
  1. Action on target
     - Verify that ... (sub-bullets for step-specific verifications)
  2. Action on target
- Final Validation:
  - Acceptance criterion ...

STRICT REWRITE RULES:
1. Translate all markdown ATX headings (### Steps, ### Validations & Acceptance Criteria) to exact colon-suffixed headers:
   "### Steps" -> "Steps:"
   "### Validations & Acceptance Criteria" -> "Final Validation:" or sub-bullets under corresponding steps
   "### Test Data" -> "Test Data:"
2. Strip or integrate [Must] / [Should] / [Critical] tags cleanly.
3. Remove modal helpers from assertions ("should be disabled" -> "is disabled").
4. Normalize conversational action phrases into clean action verbs and clean target names:
   - "Click the button that opens the simple alert" -> Click "Simple Alert"
   - "Accept the alert" / "Accept the prompt" -> Accept alert / Accept prompt
   - "Dismiss the alert" -> Dismiss alert
   - "Enter 'Ada Lovelace' in the prompt" -> Type "Ada Lovelace" into prompt
   - "Close the modal using its close control" -> Click "Close button"
5. NEVER emit unbuilt assertion types (such as AssertUnchecked, AssertFocused, AssertEmpty).
6. Preserve table rows, parameters, and {{variable}} tokens EXACTLY without modification.
7. Output ONLY the canonical text. NO markdown code blocks (\`\`\`), NO preamble, NO closing commentary.`;

/**
 * Normalizes an uploaded requirement document into canonical caseContractV1 format.
 *
 * @param {string} rawText Raw extracted text from docs.js#extractText
 * @param {object} [opts] Options bag
 * @param {object} [opts.project] Project model (to resolve AI credentials)
 * @param {string} [opts.userId] Requesting user id
 * @param {object} [opts.ai] Pre-resolved AI credentials { provider, apiKey, model }
 * @returns {Promise<string>} Canonical requirement text
 */
async function normalizeRequirementDocument(rawText, opts = {}) {
  const text = String(rawText || '').trim();
  if (!text || text.length < 20) return text;

  // If already in canonical colon format with no problematic headings, run fast deterministic pass
  if (isAlreadyCanonical(text)) {
    return deterministicNormalize(text);
  }

  // Attempt LLM normalization if credentials are available
  try {
    let aiCreds = opts.ai;
    if (!aiCreds && (opts.userId || opts.project)) {
      aiCreds = await resolveAiCredentials(opts.userId, opts.project).catch(() => null);
    }

    if (aiCreds && aiCreds.apiKey && aiCreds.provider) {
      const provider = getProvider(aiCreds.provider);
      const response = await provider.complete({
        apiKey: aiCreds.apiKey,
        model: aiCreds.model,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Please normalize the following requirement document into canonical format:\n\n${text}`,
          },
        ],
        maxTokens: 4096,
      });

      const normalized = String(response?.content || '').trim();
      if (normalized && normalized.length >= 20 && !normalized.startsWith('{') && /^\s*(?:Requirement\s+Title|Scenario|Steps)\s*:/im.test(normalized)) {
        return deterministicNormalize(normalized);
      }
    }
  } catch (err) {
    // LLM failure or rate-limit: fall back to deterministic normalization
  }

  return deterministicNormalize(text);
}

module.exports = {
  normalizeRequirementDocument,
  deterministicNormalize,
  stripModalHelpers,
  isAlreadyCanonical,
  SYSTEM_PROMPT,
};
