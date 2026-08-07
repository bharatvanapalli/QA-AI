import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { verifiedActionLocator } from '../fixtures/playwrightPomJsPrecisionAcceptance.fixture.js';

const require = createRequire(import.meta.url);
const scriptRepairAgent = require('../../server/services/scriptRepairAgent.js');

const file = 'tests/authentication/login.spec.js';
const source = [
  "import { test } from '@playwright/test';",
  "await page.getByText('Continue').click();",
  '',
].join('\n');

function failure(overrides = {}) {
  return {
    file,
    line: 2,
    error: 'strict mode violation: locator resolved to multiple elements',
    ...overrides,
  };
}

describe('script repair locator evidence safety', () => {
  it('classifies strict locator failures without treating unrelated syntax failures as locator evidence', () => {
    expect(scriptRepairAgent.isLocatorFailure(failure())).toBe(true);
    expect(scriptRepairAgent.isLocatorFailure({ error: 'SyntaxError: Unexpected token' })).toBe(false);
  });

  it('does not promote a narrative button guess without live same-node evidence', () => {
    const proposal = scriptRepairAgent.proposeRepair({
      files: { [file]: source },
      failure: failure(),
    });

    expect(proposal).toMatchObject({
      status: 'unresolved_non_blocking',
      reason: 'no_verified_action_locator_repair_available',
      nonBlocking: true,
      before: source,
    });
    expect(proposal.after).toBeUndefined();
  });

  it('rejects a syntactically exportable locator that lacks verified action proof', () => {
    const proposal = scriptRepairAgent.proposeRepair({
      files: { [file]: source },
      failure: failure({
        actionLocator: {
          expression: 'page.getByRole("button", { name: "Continue" })',
          diagnosticOnly: true,
          guess: { isGuess: true },
        },
      }),
    });

    expect(proposal.status).toBe('unresolved_non_blocking');
    expect(proposal.after).toBeUndefined();
  });

  it('repairs from the exact verified Playwright expression unchanged', () => {
    const expression = 'page.getByRole("button", { name: "Continue", exact: true })';
    const proposal = scriptRepairAgent.proposeRepair({
      files: { [file]: source },
      failure: failure({
        verifiedActionLocator: verifiedActionLocator(expression, {
          role: 'button',
          accessibleName: 'Continue',
        }),
      }),
    });

    expect(proposal).toMatchObject({
      status: 'patched',
      repairedBy: 'verified_action_locator_repair',
    });
    expect(proposal.after).toContain(`await ${expression}.click();`);
    expect(proposal.after).not.toContain("getByText('Continue')");
  });
});
