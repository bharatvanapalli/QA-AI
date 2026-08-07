import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const replayIrBdd = require('../../server/services/codegen/adapters/replayIrBdd');
const seleniumBdd = require('../../server/services/codegen/adapters/seleniumBddReference');

function authoredWaitIr() {
  return {
    version: 1,
    caseId: 'TC-BDD-AUTHORED-WAIT',
    authProfile: { id: 'none', strategy: 'none' },
    steps: [
      { op: 'resolve', as: 'records', candidates: [{ strategy: 'css', selector: '[data-testid="records"]' }] },
      {
        op: 'waitFor',
        condition: {
          kind: 'url',
          pattern: '**/arbitrary-results',
          timeoutMs: 27_431,
          refreshAfterMs: 6_217,
          recovery: { action: 'reload', maxAttempts: 7, retryAfterMs: 3_811, waitUntil: 'domcontentloaded' },
        },
      },
      {
        op: 'waitFor',
        condition: {
          kind: 'visible',
          target: 'records',
          timeoutMs: 19_873,
          refreshAfterMs: 4_309,
          recovery: { action: 'reload', maxAttempts: 1, retryAfterMs: 2_117, waitUntil: 'networkidle' },
        },
      },
    ],
    verdict: { status: 'pass', perAssertionOutcomes: [] },
  };
}

describe('BDD authored wait recovery export', () => {
  it('preserves arbitrary wait timing in Playwright-BDD Gherkin and emits deadline-bounded recovery', () => {
    const rendered = replayIrBdd.renderIr(authoredWaitIr());
    const featureSteps = rendered.lines.map((line) => line.text).join('\n');

    expect(featureSteps).toContain('wait up to 27431 milliseconds for the URL');
    expect(featureSteps).toContain('using recovery "reload" after 6217 milliseconds, retrying every 3811 milliseconds, waiting until "domcontentloaded", and maximum 7 attempts');
    expect(featureSteps).toMatch(/wait up to 19873 milliseconds for ".+" to be visible/);
    expect(featureSteps).toContain('using recovery "reload" after 4309 milliseconds, retrying every 2117 milliseconds, waiting until "networkidle", and maximum 1 attempts');

    const glue = replayIrBdd.emitGlue();
    expect(glue).toContain('function waitWithAuthoredRecovery(');
    expect(glue).toContain('const deadline = startedAt + timeoutMs;');
    expect(glue).toContain('const reloadBudget = remainingTimeout(deadline);');
    expect(glue).toContain('recoveryAttempt < maxAttempts');
    expect(glue).toContain('Date.now() + retryAfterMs');
    expect(glue).toContain('await page.reload({ timeout: reloadBudget, waitUntil });');
    expect(glue).toContain('await waiter(phaseDeadline);');
    expect(glue.match(/await page\.reload\(/g)).toHaveLength(1);
    expect(glue).not.toContain('waitForTimeout');
    expect(glue).not.toContain('27431');
    expect(glue).not.toContain('6217');
  });

  it('preserves arbitrary wait timing in Selenium-BDD Gherkin and emits deadline-bounded recovery', () => {
    const locatorCatalog = new Map();
    const feature = seleniumBdd.renderFeature({
      runResultId: 'RR-BDD-AUTHORED-WAIT',
      testCaseId: 'TC-BDD-AUTHORED-WAIT',
      status: 'pass',
      caseName: 'Arbitrary authored wait recovery',
      envelope: { ir: authoredWaitIr() },
    }, locatorCatalog);

    expect(feature).toContain('wait up to 27431 milliseconds for URL pattern');
    expect(feature).toContain('using recovery "reload" after 6217 milliseconds, retrying every 3811 milliseconds, waiting until "domcontentloaded", and maximum 7 attempts');
    expect(feature).toMatch(/wait up to 19873 milliseconds for ".+" to be visible/);
    expect(feature).toContain('using recovery "reload" after 4309 milliseconds, retrying every 2117 milliseconds, waiting until "networkidle", and maximum 1 attempts');

    const files = seleniumBdd.assemblePackage({ admitted: [], locators: locatorCatalog, envVars: [] });
    const world = Object.entries(files).find(([name]) => name.endsWith('/BddWorld.java'))?.[1] || '';
    const steps = Object.entries(files).find(([name]) => name.endsWith('/ReplayIrSteps.java'))?.[1] || '';
    expect(steps).toContain('I wait up to {long} milliseconds for URL pattern {string}');
    expect(steps).toContain('after {long} milliseconds, retrying every {long} milliseconds, waiting until {string}, and maximum {long} attempts');
    expect(steps).toContain('I wait up to {long} milliseconds for {string} to be visible');
    expect(steps).toContain('BddWorld.waitWithAuthoredRecovery(');
    expect(world).toContain('long deadline = safeDeadline(startedAt, timeoutMs);');
    expect(world).toContain('Duration.ofMillis(Math.max(1L, reloadBudget))');
    expect(world).toContain('recoveryAttempts < authoredMaxAttempts');
    expect(world).toContain('safeDeadline(System.currentTimeMillis(), retryAfterMs)');
    expect(world).toContain('pageReadyFor(authoredWaitUntil)');
    expect(world).toContain('pollUntil(condition, phaseDeadline)');
    expect(world).toContain('getImplicitWaitTimeout()');
    expect(world).toContain('getPageLoadTimeout()');
    expect(world.match(/activeDriver\.navigate\(\)\.refresh\(\)/g)).toHaveLength(1);
    expect(world).not.toContain('27431');
    expect(world).not.toContain('6217');
  });
});
