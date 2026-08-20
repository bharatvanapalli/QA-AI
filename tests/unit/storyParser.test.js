// @vitest-environment node
import { test, expect, vi } from 'vitest';
import { parseStoryToContractPacks } from '../../server/services/agents/storyParser.js';

vi.mock('../../server/lib/llmProvider.js', () => ({
  getProvider: () => ({
    complete: async () => ({
      text: JSON.stringify([
        {
          "coverageRef": "tc-1-input-workflow",
          "type": "authored_flow",
          "title": "Input Work Flow",
          "pageIntent": "Input Work Flow",
          "requiredActions": ["navigate", "fill", "assert"],
          "semanticTokens": {},
          "requiredOracles": [
            {
              "kind": "text_match",
              "target": "What is inside the text box",
              "expected": "ortonikc",
              "required": true
            }
          ],
          "sourceText": "1. Navigate to 'https://letcode.in/edit'\\n2. Enter 'Bharat Vanapalli' in Enter your full Name\\n3. Read the text present in What is inside the text box and validate the output matches 'ortonikc'"
        }
      ])
    })
  })
}));

test('Story Parser extracts values and targets from free-form text', async () => {
  const rawText = `TC 1 : Input Work Flow
1. Navigate to "https://letcode.in/edit"
2. Enter "Bharat Vanapalli" in Enter your full Name
3. Read the text present in What is inside the text box and validate the output matches "ortonikc"`;

  const packs = await parseStoryToContractPacks({
    text: rawText,
    apiKey: 'mock',
    provider: 'claude',
    model: 'claude-3-5-sonnet-20241022',
  });

  expect(packs.length).toBe(1);
  expect(packs[0].title).toBe('Input Work Flow');
  expect(packs[0].requiredActions).toContain('fill');
  expect(packs[0].requiredOracles[0].target).toBe('What is inside the text box');
  expect(packs[0].requiredOracles[0].expected).toBe('ortonikc');
});
