import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('authored flow route contract', () => {
  it('returns a deterministic, non-blocking preview before optional provider enrichment', () => {
    const source = readFileSync(resolve(process.cwd(), 'server/routes/scenarios.js'), 'utf8');

    expect(source).toContain("require('../services/authoredFlowIngestion')");
    expect(source).toContain('const authoredFlow = ingestAuthoredFlow(sourceText)');
    expect(source).toContain("mode: 'deterministic_interpretation_preview'");
    expect(source).toContain('providerEnrichmentAvailable: false');
    expect(source).toContain('authoredFlow,');
    expect(source).toContain('deterministicInterpretation: deterministicPreview');
    expect(source).toContain('? req.body.design');
    expect(source).toContain('if (!sourceText.trim())');
    expect(source).toContain("blocking: false");
    expect(source).toContain("code: enrichmentError?.code || 'OPTIONAL_ENRICHMENT_UNAVAILABLE'");
  });
});
