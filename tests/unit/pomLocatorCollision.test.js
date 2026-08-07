import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const playwrightPom = require('../../server/services/codegen/adapters/playwrightPom.js');

function caseWithSaveLocator({ caseId, title, selector }) {
  return {
    runResultId: `run-${caseId}`,
    testCaseId: caseId,
    caseName: title,
    ir: {
      version: 1,
      caseId,
      title,
      authProfile: { id: 'default', strategy: 'none', disposition: 'bypass_fixture' },
      steps: [
        {
          op: 'resolve',
          as: 'saveControl',
          pageUrl: 'https://app.example.test/users',
          elementLabel: 'Save',
          candidates: [{
            strategy: 'css',
            selector,
            expression: `page.locator(${JSON.stringify(selector)})`,
            name: 'Save',
            role: 'button',
          }],
        },
        { op: 'act', action: 'click', target: 'saveControl' },
      ],
      verdict: { status: 'pass', perAssertionOutcomes: [] },
    },
  };
}

describe('Playwright POM case-scoped locator collisions', () => {
  it('keeps both semantic locators and calls the case-specific page method', () => {
    const emitted = playwrightPom.emitJourneySpec([
      caseWithSaveLocator({ caseId: 'create-user', title: 'Create user', selector: '#save-created-user' }),
      caseWithSaveLocator({ caseId: 'delete-user', title: 'Delete user', selector: '#save-deleted-user' }),
    ], { scenarioName: 'User lifecycle', scenarioId: 'user-lifecycle', lang: 'ts' });

    const locatorSource = Object.entries(emitted.extraFiles)
      .filter(([file]) => /locators\/generated\/.*\.locators\.ts$/.test(file))
      .map(([, content]) => content)
      .join('\n');
    const pageSource = Object.entries(emitted.extraFiles)
      .filter(([file]) => /^pages\/.*Page\.ts$/.test(file))
      .map(([, content]) => content)
      .join('\n');

    expect(locatorSource).toContain('#save-created-user');
    expect(locatorSource).toContain('#save-deleted-user');
    expect(locatorSource).toContain('saveButton');
    expect(locatorSource).toContain('saveButtonForDeleteUser');
    expect(pageSource).toContain('clickSave');
    expect(pageSource).toContain('clickSaveButtonForDeleteUser');
    expect(emitted.content).toContain('.clickSave(');
    expect(emitted.content).toContain('.clickSaveButtonForDeleteUser(');
  });
});
