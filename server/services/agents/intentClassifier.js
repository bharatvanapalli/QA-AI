'use strict';

const { resolveModelForTier } = require('../../lib/modelRouter');
const { getProvider } = require('../../lib/llmProvider');

const TIER = 'mid'; // Use Haiku/Flash for high-volume classification

/**
 * Uses an LLM to semantically classify and rank a batch of interactive affordances.
 * This replaces brittle regex-based classification (e.g. DESTRUCTIVE_NAME_RE) and 
 * blind budget slicing.
 * 
 * @param {Array} rows - Array of parsed accessibility nodes { id, role, name, flags }
 * @param {Object} context - { pageUrl, pageTitle }
 * @returns {Map} - Map of id -> { safetyClass, relevanceScore }
 */
async function classifyAndRankAffordances(rows, context = {}) {
  const providerType = 'claude'; // default, will be routed by resolveModelForTier
  const resolved = resolveModelForTier({ provider: providerType, requestedModel: null, tier: TIER });
  const provider = getProvider(resolved.provider);

  if (!rows || rows.length === 0) {
    return new Map();
  }

  // Assign temporary IDs if they don't have one to correlate the response
  const payload = rows.map((r, i) => ({
    id: r.id || `node_${i}`,
    role: r.role,
    name: r.name,
    disabled: !!r.flags?.disabled,
    haspopup: !!r.flags?.haspopup
  }));

  const systemPrompt = `You are an expert QA Engineer's structural intent classifier.
Your job is to analyze interactive UI elements (buttons, links, tabs, etc.) and determine:
1. Their safety class (what action they perform).
2. Their architectural relevance score (how important they are to explore for functional mapping).

Available safety classes:
- "destructive": Mutating, destructive, or session-ending actions (e.g., Save, Submit, Delete, Logout, Upload, Add, Pay). NEVER click these during a read-only crawl. 
  IMPORTANT: Look at the intent in any language. "Guardar", "Eliminar", "Erase" are all destructive.
- "tab": Role=tab. Panel switches that don't change the URL.
- "filter": Safe to open. Search, sort, or filter affordances (e.g., "Advanced Search", "Sort by Date").
- "dropdown": Safe to open. Selection menus, comboboxes, or buttons that open popups.
- "nav": Links, menuitems, or treeitems that navigate to new pages.
- "other": Anything else that doesn't fit the above.

Relevance Score (0-100):
- 90-100: Core business configuration, Admin dashboards, Payment settings, Complex forms.
- 50-89: Standard content pages, User lists, Reports.
- 10-49: Generic marketing, About Us, Privacy Policy, Terms of Service.
- 0: Unclickable or irrelevant.

Output MUST be valid JSON in this exact format, with NO markdown formatting or other text:
{
  "results": [
    { "id": "node_0", "safetyClass": "destructive", "relevanceScore": 0 },
    ...
  ]
}
`;

  let userConstraints = '';
  if (context.explicitCrawlHints || context.userStoryContext) {
    userConstraints = `\nCRITICAL USER CONSTRAINTS:\nThe user has provided specific instructions for what to test. You MUST score relevance based on these instructions. Elements matching these instructions MUST get a 100 Relevance Score. Elements explicitly excluded or totally irrelevant to these instructions MUST get a 0-10 score.\n`;
    if (context.explicitCrawlHints) {
      userConstraints += `\nEXPLICIT CRAWL HINTS:\n${context.explicitCrawlHints}\n`;
    }
    if (context.userStoryContext) {
      userConstraints += `\nUSER STORY / REQUIREMENTS:\n${context.userStoryContext}\n`;
    }
  }

  const userPrompt = `Page Context:
URL: ${context.pageUrl || 'unknown'}
Title: ${context.pageTitle || 'unknown'}
${userConstraints}
Elements to classify:
${JSON.stringify(payload, null, 2)}`;

  let parsed = { results: [] };
  try {
    const response = await provider.complete({
      model: resolved.model,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0,
      maxTokens: 4000,
      jsonMode: true,
    });
    
    // Sometimes the LLM wraps in markdown even when jsonMode is true depending on the exact provider implementation
    const text = response.text.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
    parsed = JSON.parse(text);
  } catch (err) {
    console.error('[intentClassifier] LLM classification failed, falling back to heuristics:', err);
    // Fallback gracefully to basic regex if LLM fails
    const { classifyAffordance } = require('../../lib/crawlPlanner'); // Circular safe if only required here
    parsed.results = payload.map(p => ({
      id: p.id,
      safetyClass: classifyAffordance(p),
      relevanceScore: 50 // baseline fallback score
    }));
  }

  const resultMap = new Map();
  for (const res of (parsed.results || [])) {
    resultMap.set(res.id, res);
  }
  return resultMap;
}

module.exports = {
  classifyAndRankAffordances
};
