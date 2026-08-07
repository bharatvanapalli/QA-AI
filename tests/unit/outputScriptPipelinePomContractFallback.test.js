import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const outputScriptPipeline = require('../../server/services/outputScriptPipeline.js');

function emittedSource(built) {
  return Object.values(built.files || {}).join('\n');
}

describe('Playwright POM authored-contract fallback', () => {
  it('keeps a contract-only result downloadable as diagnostics without guessed runnable actions', () => {
    const built = outputScriptPipeline.buildDraftArtifacts({
      adapterId: 'playwright-pom-js',
      adapterVersion: 'test',
      targetUrl: 'https://identity.example.test/auth/email-classifier',
      results: [
        {
          runResultId: 'run-contract-only',
          testCaseId: 'case-contract-only',
          moduleName: 'authentication',
          caseName: 'Email Classifier Sign-In',
          declaredSteps: [
            {
              id: 'open-email-classifier',
              action: 'navigate',
              url: 'https://identity.example.test/auth/email-classifier',
              expectedPageTitle: 'Email Classifier',
            },
            {
              id: 'continue',
              action: 'click',
              target: 'Continue',
              expectedPageTitle: 'Email Classifier',
            },
            {
              id: 'continue',
              action: 'click',
              target: 'Continue',
              expectedPageTitle: 'Email Classifier',
            },
          ],
          declaredAssertionsRaw: [
            {
              id: 'email-classifier-visible',
              type: 'UI_TEXT',
              expected: 'Email Classifier',
              soft: true,
            },
          ],
        },
      ],
    });

    const source = emittedSource(built);
    const spec = Object.entries(built.files).find(([name]) => /\.spec\.js$/.test(name))?.[1] || '';
    const continueCalls = spec.match(/await\s+\w+\.click\w*Continue\w*\(/g) || [];
    const status = JSON.parse(built.files['evidence/live-output-status.json']);

    expect(continueCalls).toHaveLength(0);
    expect(status).toMatchObject({ allBlocked: false });
    expect(source).not.toContain('QAAI_GUESSED_LOCATOR');
    expect(source).toContain('Email Classifier');
    expect(spec).not.toMatch(/Source-run diagnostics|QAAI generated this complete script/i);
    expect(source).not.toMatch(/test\.info\(\)\.annotations|qaai-source-diagnostic/i);
    expect(source).not.toContain('assertPageUiText("Email Classifier")');
    expect(source).not.toContain('expect.soft(false');
    expect(source).not.toMatch(/TODO implement step|TODO oracle/i);
    expect(Object.keys(built.files).some((name) => /\.diagnostic\.js$/.test(name))).toBe(true);
  });
});
