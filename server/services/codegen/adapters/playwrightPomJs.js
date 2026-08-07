'use strict';
/**
 * playwright-pom-js — JavaScript variant of the Playwright POM adapter.
 * Emits the same locators/ + pages/ + tests/ structure as playwright-pom
 * but with .js extensions and no TypeScript type annotations.
 *
 * Thin wrapper: normalizes the JS projection, then delegates to
 * playwrightPom.emitJourneySpec with { lang: 'js' }.
 */
const playwrightPom = require('./playwrightPom');
const standardProfile = require('./playwrightPomJsStandardProfile');

const ADAPTER_ID = 'playwright-pom-js';
const STANDARD_OUTPUT_PROFILE = 'playwright-pom-js-v1';

function emitJourneySpec(cases, opts = {}) {
  const emitted = playwrightPom.emitJourneySpec(
    standardProfile.prepareCasesForStandardOutput(cases),
    {
      ...opts,
      adapterId: ADAPTER_ID,
      selectedFramework: ADAPTER_ID,
      legacyFallbackUsed: false,
      lang: 'js',
      standardOutputProfile: STANDARD_OUTPUT_PROFILE,
    },
  );
  return standardProfile.finalizeStandardOutput(emitted);
}

module.exports = {
  id: ADAPTER_ID,
  emitJourneySpec,
  _prepareCasesForStandardOutput: standardProfile.prepareCasesForStandardOutput,
  _standardOutputProfile: STANDARD_OUTPUT_PROFILE,
};
