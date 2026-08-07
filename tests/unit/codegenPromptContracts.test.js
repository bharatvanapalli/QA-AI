import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const locators = require('../../server/services/codegen/_locators');
const pom = require('../../server/services/codegen/pom');
const playwrightJs = require('../../server/services/codegen/playwrightJs');
const playwrightBdd = require('../../server/services/codegen/playwrightBdd');
const selenium = require('../../server/services/codegen/selenium');
const seleniumBdd = require('../../server/services/codegen/seleniumBdd');
const journey = require('../../server/services/codegen/_journey');

describe('legacy codegen prompt contracts', () => {
  it.each(['ts', 'js', 'java'])('keeps verified locator priority and preserves kbMiss actions for %s', (lang) => {
    const prompt = locators.locatorPromptBlock({ lang });

    expect(prompt).toContain('GROUND TRUTH');
    expect(prompt).toContain('VERBATIM');
    expect(prompt).toContain('Verified-locator priority is absolute');
    expect(prompt).toContain('exactly ONE');
    expect(prompt).toContain('QAAI_GUESSED_LOCATOR');
    expect(prompt).toContain('live DOM evidence was unavailable');
    expect(prompt).toContain('replace this guessed locator with a reliable DOM locator if needed');
    expect(prompt).not.toContain('QAAI_UNRESOLVED_LOCATOR');
  });

  it.each([
    ['playwright-pom-ts', pom.SYSTEM_PROMPT],
    ['playwright-pom-js', playwrightJs.SYSTEM_PROMPT],
  ])('%s fails visibly instead of skipping absent prerequisite data', (_name, prompt) => {
    expect(prompt).toContain('QAAI_PREREQUISITE_MISSING');
    expect(prompt).toContain('replay that declared setup');
    expect(prompt).toContain('Keep every dependent Page Object method, action, and assertion');
    expect(prompt).not.toContain('test.skip(true');
    expect(prompt).not.toContain('Prerequisite data not found — run the full suite');
  });

  it('keeps the full declared prerequisite chain in the flat journey prompt', () => {
    const prompt = journey.journeySystemPrompt({ lang: 'ts' });

    expect(prompt).toContain('DEPENDENCY COMPLETENESS');
    expect(prompt).toContain('Replay every upstream setup/creation step');
    expect(prompt).toContain('QAAI_PREREQUISITE_MISSING');
    expect(prompt).toContain('keep every step in the source');
  });

  it.each([
    ['playwright-bdd', playwrightBdd.SYSTEM_PROMPT],
    ['selenium-java', selenium.SYSTEM_PROMPT],
    ['selenium-bdd', seleniumBdd.SYSTEM_PROMPT],
  ])('%s preserves dependent steps and requires an explicit prerequisite failure', (_name, prompt) => {
    expect(prompt).toContain('DATA DEPENDENCIES');
    expect(prompt).toContain('QAAI_PREREQUISITE_MISSING');
    expect(prompt).toMatch(/Preserve every|Preserve every approved/);
    expect(prompt).toMatch(/Never (?:emit|use)/);
  });
});
