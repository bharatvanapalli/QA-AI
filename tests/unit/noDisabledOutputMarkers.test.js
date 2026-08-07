import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const outputScriptPipeline = require('../../server/services/outputScriptPipeline.js');

describe('legacy output fallback remains enabled', () => {
  it('never emits skip/fixme markers for a source-diagnostic case', () => {
    const built = outputScriptPipeline.buildDraftArtifacts({
      adapterId: 'playwright-reference',
      targetUrl: 'https://app.example.test',
      results: [{
        runResultId: 'run-diagnostic',
        testCaseId: 'case-diagnostic',
        caseName: 'Recover user flow',
        status: 'failed',
        declaredSteps: [{ action: 'Navigate', value: 'https://app.example.test/users' }],
      }],
      blocked: [{ runResultId: 'run-diagnostic', code: 'source_evidence_incomplete' }],
    });

    const specs = Object.entries(built.files).filter(([file]) => /\.spec\.[jt]s$/.test(file));
    expect(specs).toHaveLength(1);
    expect(specs[0][1]).not.toMatch(/test\.describe\.skip|test\.skip|test\.fixme/);
    expect(specs[0][1]).toContain('expect.soft(false');
    expect(built.artifacts[0]).toMatchObject({ blockers: [], diagnostics: ['source_evidence_incomplete'] });
  });

  it('keeps the empty-source diagnostic executable instead of skipped', () => {
    const built = outputScriptPipeline.buildDraftArtifacts({ adapterId: 'playwright-reference', results: [] });
    const spec = built.files['tests/preview/no-generated-case.preview.spec.ts'];
    expect(spec).not.toMatch(/test\.describe\.skip|test\.skip|test\.fixme/);
    expect(spec).toContain('expect.soft(false');
  });
});
