'use strict';

const { getProvider } = require('../../lib/llmProvider');
const { resolveModelForTier } = require('../../lib/modelRouter');

const SYSTEM_PROMPT = `You are QAAI Story Parser, an expert at converting free-form natural language test stories, manual test cases, and procedural flows into structured JSON CaseContractPacks.
Your goal is to parse unstructured English text (like 'Navigate to X', 'Enter Y in Z') into a strict JSON array of CaseContractPack objects.

# Instructions
1. Analyze the input text to identify distinct scenarios or test cases.
2. For each distinct case, output exactly one CaseContractPack.
3. Determine the target element names and input values accurately based on context, without relying on quotation marks.
4. Output a STRICT JSON array of objects matching the CaseContractPack schema. No markdown wrapping, no prose.

# CaseContractPack Schema
Each object in the array must have the following fields:
- coverageRef: A unique string ID for this pack (e.g., "story-1-case-1").
- type: "authored_flow"
- title: A descriptive title for the case.
- pageIntent: The primary goal or focus of the case.
- requiredActions: Array of strings categorizing the actions (e.g., ["navigate", "fill", "assert"]).
- semanticTokens: An object mapping variable names to their values (if any data is provided).
- requiredOracles: Array of oracle objects representing final assertions. Each oracle object has:
    - kind: "state_change" or "text_match" or "visibility"
    - target: The element or condition being asserted.
    - expected: The expected value or state.
    - required: true
- sourceText: The original text that this pack represents (so the downstream Architect can see the raw steps).

# Output Format
Return ONLY a valid JSON array. For example:
[
  {
    "coverageRef": "tc-1-input-workflow",
    "type": "authored_flow",
    "title": "Input Work Flow",
    "pageIntent": "Input Work Flow",
    "requiredActions": ["navigate", "fill", "assert", "clear"],
    "semanticTokens": {},
    "requiredOracles": [
      {
        "kind": "text_match",
        "target": "What is inside the text box",
        "expected": "ortonikc",
        "required": true
      },
      {
        "kind": "state_change",
        "target": "Confirm edit field is disabled",
        "expected": "disabled",
        "required": true
      }
    ],
    "sourceText": "1. Navigate to 'https://letcode.in/edit'\\n2. Enter 'Bharat Vanapalli' in Enter your full Name\\n..."
  }
]
`;

async function parseStoryToContractPacks({ 
  text, 
  apiKey, 
  provider: providerName, 
  model: requestedModel, 
  onLog = async () => {},
  signal 
}) {
  if (!text || !String(text).trim()) return [];

  const provider = getProvider(providerName);
  const model = resolveModelForTier({ provider: providerName, requestedModel, tier: 'high' });
  
  await onLog('info', `AI Story Parser: analyzing ${text.length} characters to extract CaseContractPacks.`);

  let responseText = '';
  try {
    const result = await provider.complete({
      model,
      apiKey,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: String(text) }
      ],
      temperature: 0.1,
      signal
    });
    responseText = (Array.isArray(result?.content) ? result.content.filter((c) => c.type === 'text').map((c) => c.text).join('') : '') || result?.text || '';
  } catch (error) {
    await onLog('error', `Story Parser failed: ${error.message}`);
    throw error;
  }

  // Attempt to parse the JSON
  let packs = [];
  try {
    let cleanText = responseText.trim();
    if (cleanText.startsWith('```json')) cleanText = cleanText.slice(7);
    if (cleanText.startsWith('```')) cleanText = cleanText.slice(3);
    if (cleanText.endsWith('```')) cleanText = cleanText.slice(0, -3);
    cleanText = cleanText.trim();
    const firstBracket = cleanText.indexOf('[');
    const lastBracket = cleanText.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      cleanText = cleanText.slice(firstBracket, lastBracket + 1);
    }
    const parsed = JSON.parse(cleanText);
    if (parsed && Array.isArray(parsed)) {
      packs = parsed;
    } else {
      throw new Error('Parsed response did not return an array');
    }
  } catch (err) {
    await onLog('warn', `Story Parser returned invalid JSON. Falling back to empty array. Response: ${responseText.slice(0, 100)}...`);
    return [];
  }

  // Sanitize the packs
  return packs.map((pack, index) => ({
    schemaVersion: '1.0',
    contractVersion: '1.0',
    coverageRef: pack.coverageRef || `story-parsed-${Date.now()}-${index}`,
    type: pack.type || 'authored_flow',
    syntheticFromClause: true,
    sourceText: pack.sourceText || text,
    aliases: [],
    storyId: `story-${Date.now()}`,
    module: 'ParsedFlow',
    title: pack.title || `Parsed Case ${index + 1}`,
    pageIntent: pack.pageIntent || pack.title || `Parsed Case ${index + 1}`,
    requiredFields: [],
    requiredActions: Array.isArray(pack.requiredActions) ? pack.requiredActions : [],
    semanticTokenMap: pack.semanticTokens || {},
    semanticTokens: pack.semanticTokens || {},
    rowIntent: {
      sheet: null,
      rowSelector: null,
      rowIds: [],
      rowSource: 'needs_mapping'
    },
    requiredOracle: (pack.requiredOracles && pack.requiredOracles[0]) || {
      kind: 'state_change',
      target: pack.title || 'Parsed Case',
      expected: true,
      source: 'story_parser',
      required: true
    },
    requiredOracles: Array.isArray(pack.requiredOracles) ? pack.requiredOracles : [],
    allowedPages: [],
    allowedCapabilities: [],
    dataRows: [],
    rowIntents: [],
    authPreconditions: [],
    capabilityHints: []
  }));
}

module.exports = {
  parseStoryToContractPacks
};
