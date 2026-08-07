import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightReference = require('../../server/services/codegen/adapters/playwrightReference.js');
const pageObjectRepository = require('../../server/services/codegen/pageObjectRepository.js');

const orderedCandidates = [
  { strategy: 'testId', testId: 'save-user' },
  { strategy: 'role', role: 'button', name: 'Save user' },
  { strategy: 'label', text: 'Save user' },
  { strategy: 'placeholder', text: 'Save user' },
  { strategy: 'css', selector: '[data-qa="save-user"]' },
  { strategy: 'text', text: 'Save user' },
];

describe('Playwright locator candidate priority', () => {
  it.each([
    [0, 'page.getByTestId("save-user")'],
    [1, 'page.getByRole("button", { name: "Save user" })'],
    [2, 'page.getByLabel("Save user")'],
    [3, 'page.getByPlaceholder("Save user")'],
    [4, 'page.locator("[data-qa=\\"save-user\\"]")'],
    [5, 'page.getByText("Save user", { exact: true })'],
  ])('selects tier %i before every weaker remaining tier', (start, expected) => {
    expect(playwrightReference.selectStaticLocator(orderedCandidates.slice(start))).toBe(expected);
  });

  it('keeps the selected candidate diagnostic-only until same-node browser proof exists', () => {
    const repository = pageObjectRepository.buildLocatorRepository({
      cases: [{
        ir: {
          steps: [
            { op: 'act', action: 'navigate', url: 'https://example.test/users' },
            {
              op: 'resolve',
              as: 'saveControl',
              pageUrl: 'https://example.test/users',
              elementLabel: 'Save user button',
              candidates: orderedCandidates,
            },
          ],
        },
      }],
    });

    expect(repository.files).toEqual({});
    expect(repository.manifest).toEqual([]);
    expect(repository.diagnostics).toEqual([
      expect.objectContaining({
        as: 'saveControl',
        executable: false,
        diagnosticOnly: true,
        reason: 'candidate_only_locator',
        candidateExpression: 'page.getByTestId("save-user")',
      }),
    ]);
  });
});
